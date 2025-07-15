/*  functions/index.js — ThinkHelper backend v3.6
    · Vertex AI (Gemini-2.0-Flash) REST
    · CORS white-list 3개 도메인
    · /suggestAI · /gpt · /search · /suggestGoogle · /health
    ───────────────────────────────────────────────────────── */

    import express        from 'express';
    import cors           from 'cors';
    import axios          from 'axios';
    import { GoogleAuth } from 'google-auth-library';
    import { onRequest }  from 'firebase-functions/v2/https';
    import { defineSecret } from 'firebase-functions/params';
    
    /*──────────────────── 0. Secrets ───────────────────*/
    const GOOGLE = defineSecret('GOOGLE_API_KEY');   // Google CSE key
    const CSE_ID = defineSecret('GOOGLE_CSE_ID');    // Google CSE CX
    
    /*──────────────────── 1. Vertex 설정 ───────────────*/
    const PROJECT_ID     = process.env.GCLOUD_PROJECT;
    const VERTEX_REGION  = 'us-central1';
    const PRIMARY_MODEL  = 'gemini-2.0-flash';
    const FALLBACK_MODEL = 'gemini-pro';
    
    /*──────────────────── 2. Vertex REST helper ────────*/
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    async function callVertex({ prompt, modelId = PRIMARY_MODEL, maxTokens = 512 }) {
      const client  = await auth.getClient();
      const { token } = await client.getAccessToken();
      const model   = `projects/${PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${modelId}`;
      const url     = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/${model}:generateContent`;
    
      try {
        const { data } = await axios.post(
          url,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens }
          },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        /* 모델 ID 미배포 → fallback */
        if (String(err.response?.data?.error?.message || err.message).includes('NOT_FOUND')
            && modelId !== FALLBACK_MODEL) {
          console.warn(`[Vertex] ${modelId} NOT_FOUND → fallback ${FALLBACK_MODEL}`);
          return callVertex({ prompt, modelId: FALLBACK_MODEL, maxTokens });
        }
        throw err;
      }
    }
    
    /*──────────────────── 3. Express & CORS ───────────*/
    const app = express();
    
    app.use(cors({
      origin: [
        'https://5506-firebase-thinkhelper-1-1751178473634.cluster-bg6uurscprhn6qxr6xwtrhvkf6.cloudworkstations.dev',
        'https://thinkhelper.web.app',
        'https://thinkhelper-v2.web.app'
      ],
      credentials: true
    }));
    app.options('*', cors());          // pre-flight
    app.use(express.json());
    app.use((req, _res, next) => { console.log('▶', req.method, req.originalUrl); next(); });
    
    /*──────────────────── 4. Router ───────────────────*/
    const router = express.Router();
    
    /* 4-1. 한글/영문 1글자 → 5단어 (로컬 fallback) */
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
    const koQA = w => `${w}이(가) 무엇인가요? 한 줄로 설명하면 이렇습니다.`;
    const enQA = w => `What is ${w}? It's a basic concept everyone should know.`;
    const pickWords = ch =>
      /[가-힣]/.test(ch) ? (KO_MAP[ch] || KO_MAP['가'])
                         : (EN_MAP[ch.toLowerCase()] || EN_MAP['a']);
    
    /* ---------- 4-2. /suggestAI  (문장 5개 전용) ---------- */
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
    
      /* (1) Vertex로 문장 5개 시도 – 1글자여도 호출 */
      let sentences = [];
      try {
        const raw = await callVertex({ prompt: PROMPT(kw, mode), maxTokens: 128 });
        sentences = raw.split(/\n/).map(s => s.trim()).filter(Boolean).slice(0, 5);
      } catch (e) {
        console.warn('/suggestAI Vertex fail ▶', e.message);
      }
    
      /* (2) 로컬 단어 백업 (프론트 fallback용) */
      const words = pickWords(kw[0] || 'a');
    
      res.json({ words, sentences });
    });
    
    /* ---------- 4-3. /gpt -------------------------------- */
    router.post('/gpt', async (req, res) => {
      const text = (req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      try {
        const out = await callVertex({ prompt: text, maxTokens: 512 });
        res.json({ response: { text: out } });
      } catch (e) {
        console.warn('/gpt fail ▶', e.message);
        res.json({ response: { text: '🤖 모델 오류—잠시 후 다시 시도해 주세요.' } });
      }
    });
    
    /* ---------- 4-4. Google Suggest / Search ------------- */
    router.get('/suggestGoogle', async (req, res) => {
      const q = (req.query?.q || '').trim();
      if (!q) return res.json({ sug: [] });
      try {
        const { data } = await axios.get(
          'https://suggestqueries.google.com/complete/search',
          { params: { client: 'firefox', hl: 'ko', q } }
        );
        res.json({ sug: Array.isArray(data[1]) ? data[1].slice(0, 10) : [] });
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
          { params: { key: GOOGLE.value(), cx: CSE_ID.value(), q } }
        );
        const links = (data.items || []).map(i => ({
          title: i.title, link: i.link, snippet: i.snippet
        }));
        res.json({ links });
      } catch (e) {
        console.warn('/search fail', e.message);
        res.json({ links: [] });
      }
    });
    
    /* ---------- 4-5. 기타 ------------------------------- */
    router.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
    
    router.all('/gpt', (req, res) => {
      if (req.method !== 'POST') res.status(405).json({ error: 'method not allowed' });
    });
    router.all(['/suggestGoogle', '/search'], (req, res) => {
      if (req.method !== 'GET') res.status(405).json({ error: 'method not allowed' });
    });
    
    /* ---------- prefix & 404 ---------------------------- */
    app.use('/api', router);
    app.use((_req, res) => res.status(404).json({ error: 'unknown endpoint' }));
    
    /*──────────────────── 5. Cloud Function export ───────*/
    export const api = onRequest(
      { region: 'asia-northeast3', secrets: [GOOGLE, CSE_ID] },
      app
    );
    
