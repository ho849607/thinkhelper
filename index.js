// server.mjs — ThinkHelper backend (EC2/Express, OpenAI 호환 gpt5nano)
import 'dotenv/config';
import express from 'express';
import cors    from 'cors';
import axios   from 'axios';

/*────────── 0) Env ──────────*/
const {
  PORT = 3000,
  AI_API_KEY,
  AI_BASE_URL = 'https://api.openai.com',
  AI_MODEL = 'gpt5nano',
  AI_TIMEOUT_MS = '20000',
  GOOGLE_API_KEY,
  GOOGLE_CSE_ID,
  CORS_ORIGINS = 'http://localhost:5173,https://thinkhelper.web.app,https://thinkhelper-v2.web.app'
} = process.env;

if (!AI_API_KEY) throw new Error('AI_API_KEY is required');
if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) console.warn('⚠️ GOOGLE_API_KEY / GOOGLE_CSE_ID 미설정: /search는 동작 안 할 수 있음');

/*────────── 1) AI 호출 ──────*/
const ALLOWED_MODELS = new Set(['gpt5nano','gptnano','chatgpt5nano']);
const DEFAULT_MODEL  = AI_MODEL;
const TIMEOUT_MS     = Number(AI_TIMEOUT_MS || '20000');

async function callAI({ prompt, modelId = DEFAULT_MODEL, maxTokens = 512, temperature = 0.7 }) {
  if (!ALLOWED_MODELS.has(modelId)) throw new Error(`unsupported_model: ${modelId}`);

  const url = `${AI_BASE_URL.replace(/\/+$/,'')}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { data } = await axios.post(
      url,
      { model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature },
      {
        signal: controller.signal,
        timeout: TIMEOUT_MS + 1000,
        headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' }
      }
    );
    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.output ?? data?.text ?? '';
    return String(text || '').trim();
  } catch (err) {
    const msg = String(err?.response?.data?.error?.message || err?.message || '');
    if (!/gptnano/.test(modelId) && /not found|404|unknown model/i.test(msg)) {
      console.warn(`[AI] ${modelId} not available → fallback gptnano`);
      return callAI({ prompt, modelId: 'gptnano', maxTokens, temperature });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/*────────── 2) App/CORS ────*/
const app = express();
const origins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins, credentials: true }));
app.options('*', cors());
app.use(express.json());
app.use((req, _res, next) => { console.log('▶', req.method, req.originalUrl); next(); });

/*────────── 3) 라우터 ───────*/
const router = express.Router();

/* 3-1. 단어 fallback */
const KO_MAP = {
  가:['가방','가게','가구','가족','가치'], 나:['나무','나라','나비','나이','나열'],
  다:['다리','다짐','다방','다양','다툼'], 라:['라디오','라면','라벨','라이브','라운드'],
  마:['마음','마을','마법','마차','마켓'], 바:['바다','바람','바늘','바보','바위'],
  사:['사과','사랑','사전','사막','사슴'], 아:['아침','아이','아이스','아파트','아빠'],
  자:['자유','자동차','자료','자연','자전거'], 차:['차량','차트','차표','차이','차원'],
  카:['카드','카메라','카카오','카페','카운트'], 타:['타워','타자','타임','타일','타깃'],
  파:['파랑','파도','파워','파일','파티'],     하:['하늘','하트','하이','하마','하루']
};
const EN_MAP = {
  a:['apple','angel','album','area','award'],   b:['banana','bird','bridge','brown','brave'],
  c:['city','cloud','circle','coffee','candle'],d:['dog','dance','dream','drama','draft'],
  e:['eagle','earth','energy','event','extra'],f:['flower','forest','future','focus','fresh'],
  g:['grape','green','garden','giant','glory'],h:['house','heart','happy','human','hobby'],
  i:['island','idea','image','issue','iron'],  j:['juice','jungle','jewel','judge','joint'],
  k:['kite','king','kitchen','kit','kind'],    l:['lion','light','logic','lake','leaf'],
  m:['moon','music','market','magic','model'], n:['night','note','nature','number','noble'],
  o:['ocean','orange','orbit','order','owner'],p:['piano','paper','peace','power','party'],
  q:['queen','quick','quiet','quest','quote'], r:['river','road','robot','rain','ready'],
  s:['sun','star','smart','story','style'],    t:['tree','travel','table','trend','trust'],
  u:['umbrella','union','unique','urban','upper'],v:['violet','value','voice','visit','vivid'],
  w:['whale','water','world','window','wise'], x:['xylophone','xenon','xerox','xmas','x-ray'],
  y:['yacht','yellow','youth','yield','yummy'],z:['zebra','zero','zone','zoom','zen']
};
const pickWords = ch =>
  /[가-힣]/.test(ch) ? (KO_MAP[ch] || KO_MAP['가'])
                     : (EN_MAP[ch?.toLowerCase?.()] || EN_MAP['a']);

/* 3-2. /suggestAI — 문장 5개 */
const PROMPT = (kw, mode) => `
"${kw}" 글자로 시작한다고 예상되는 **완성 문장 5개**를 ${mode} 스타일 한국어로.
- 숫자·영어·특수문자 최소화
- 각 문장은 마침표 포함
- 줄바꿈으로만 구분
`;

router.post('/suggestAI', async (req, res) => {
  const kw   = (req.body?.keyword || '').trim();
  const mode = (req.body?.mode    || 'basic').trim();
  if (!kw) return res.status(400).json({ error: 'keyword required' });
  let sentences = [];
  try {
    const raw = await callAI({ prompt: PROMPT(kw, mode), maxTokens: 128 });
    sentences = String(raw).split(/\r?\n/)
      .map(s => s.trim().replace(/^[\-\d\.\)]\s*/, ''))
      .filter(Boolean).slice(0, 5);
  } catch (e) {
    console.warn('/suggestAI AI fail ▶', e.message);
  }
  const words = pickWords(kw[0] || 'a');
  res.json({ words, sentences });
});

/* 3-3. /gpt — 일반 프롬프트 */
router.post('/gpt', async (req, res) => {
  const text  = (req.body?.text  || '').trim();
  const model = (req.body?.model || DEFAULT_MODEL).trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const out = await callAI({ prompt: text, modelId: model, maxTokens: 512 });
    res.json({ response: { text: out } });
  } catch (e) {
    console.warn('/gpt fail ▶', e.message);
    res.json({ response: { text: '🤖 모델 오류—잠시 후 다시 시도해 주세요.' } });
  }
});

/* 3-4. Google Suggest / Search */
router.get('/suggestGoogle', async (req, res) => {
  const q = (req.query?.q || '').trim();
  if (!q) return res.json({ sug: [] });
  try {
    const { data } = await axios.get(
      'https://suggestqueries.google.com/complete/search',
      { params: { client: 'firefox', hl: 'ko', q } }
    );
    res.json({ sug: Array.isArray(data?.[1]) ? data[1].slice(0, 10) : [] });
  } catch (e) {
    console.warn('/suggestGoogle fail', e.message);
    res.json({ sug: [] });
  }
});

router.get('/search', async (req, res) => {
  const q = (req.query?.q || '').trim();
  if (!q) return res.json({ links: [] });
  try {
    const { data } = await axios.get(
      'https://www.googleapis.com/customsearch/v1',
      { params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q } }
    );
    const links = (data?.items || []).map(i => ({
      title: i.title, link: i.link, snippet: i.snippet
    }));
    res.json({ links });
  } catch (e) {
    console.warn('/search fail', e.message);
    res.json({ links: [] });
  }
});

/* 3-5. 기타/가드 */
router.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
router.all('/gpt', (req, res, next) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  return next();
});
router.all(['/suggestGoogle','/search'], (req, res, next) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  return next();
});

app.use('/api', router);
app.use((_req, res) => res.status(404).json({ error: 'unknown endpoint' }));

app.listen(PORT, () => console.log(`✅ ThinkHelper API listening on :${PORT}`));
