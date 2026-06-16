import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Favicon
app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0a0a0a" stroke="#ffd700" stroke-width="2"/><text x="16" y="23" font-size="16" text-anchor="middle" fill="#ffd700">🎯</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})
app.get('/favicon.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0a0a0a" stroke="#ffd700" stroke-width="2"/><text x="16" y="23" font-size="16" text-anchor="middle" fill="#ffd700">🎯</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})

// ====== nazogaku.com スクレイピング ======
async function fetchArticleUrls(category: string, page: number = 1): Promise<string[]> {
  const url = `https://nazogaku.com/${category}/page/${page}/`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)', 'Accept': 'text/html' }
    })
    if (!res.ok) return []
    const html = await res.text()
    const matches = html.matchAll(/href="(https:\/\/nazogaku\.com\/q\d+\/)"/g)
    const urls: string[] = []
    for (const m of matches) {
      if (!urls.includes(m[1])) urls.push(m[1])
    }
    return urls
  } catch { return [] }
}

async function fetchQuizDetail(url: string): Promise<{ question: string; answer: string; hint: string; imageUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)' }
    })
    if (!res.ok) return null
    const html = await res.text()

    // description から問題文
    const descMatch = html.match(/<meta name="description" content="([^"]+)"/)
    let question = ''
    if (descMatch) {
      question = descMatch[1].replace(/^なぞなぞ[クイズ：\s]*：?\s*/, '').trim()
    }

    // post_content から答え・ヒント
    const pcStart = html.indexOf('class="post_content">')
    const pcEnd = html.indexOf('</article', pcStart)
    const postContent = pcStart !== -1 ? html.slice(pcStart, pcEnd !== -1 ? pcEnd : pcStart + 5000) : ''

    const cleanText = postContent
      .replace(/<ruby>/g, '').replace(/<\/ruby>/g, '')
      .replace(/<rt>[^<]*<\/rt>/g, '').replace(/<rp>[^<]*<\/rp>/g, '')
      .replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim()

    const lines = cleanText.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0)

    let answer = ''
    let hint = ''
    const answerIdx = lines.findIndex((l: string) => l.includes('えをみる'))
    if (answerIdx !== -1 && answerIdx + 1 < lines.length) {
      answer = lines[answerIdx + 1].replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
    }
    const hintIdx = lines.findIndex((l: string) => l.includes('博士'))
    if (hintIdx !== -1 && hintIdx + 1 < lines.length) {
      hint = lines[hintIdx + 1].replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
    }

    const imgMatch = html.match(/thumbnailUrl":"(https:\/\/nazogaku\.com\/wp-content\/[^"]+)"/)
    const imageUrl = imgMatch ? imgMatch[1] : ''

    if (!question) return null
    return { question, answer, hint, imageUrl }
  } catch { return null }
}

// ====== API: ランダム問題取得 ======
app.get('/api/quiz', async (c) => {
  const category = c.req.query('category') || 'random'
  const categories = ['very-easy', 'easy', 'normal', 'hard']
  const selectedCategory = category === 'random'
    ? categories[Math.floor(Math.random() * categories.length)]
    : category

  if (!categories.includes(selectedCategory)) {
    return c.json({ error: 'Invalid category' }, 400)
  }

  const maxPage = 29
  const randomPage = Math.floor(Math.random() * maxPage) + 1
  let urls = await fetchArticleUrls(selectedCategory, randomPage)
  if (urls.length === 0) urls = await fetchArticleUrls(selectedCategory, 1)
  if (urls.length === 0) return c.json({ error: 'Failed to fetch quiz list' }, 500)

  const randomUrl = urls[Math.floor(Math.random() * urls.length)]
  const quiz = await fetchQuizDetail(randomUrl)
  if (!quiz) return c.json({ error: 'Failed to fetch quiz detail' }, 500)

  return c.json({ ...quiz, category: selectedCategory, sourceUrl: randomUrl })
})

// ====== ルールベース判定（フォールバック用） ======
function ruleBasedJudge(correctAnswer: string, userAnswer: string): { result: string; isExact: boolean } {
  const normalize = (s: string) => s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[ぁ-ん]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひら→カタ
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角

  const ca = normalize(correctAnswer)
  const ua = normalize(userAnswer)

  // 完全一致
  if (ca === ua) return { result: '○', isExact: true }
  // 含む
  if (ca.includes(ua) || ua.includes(ca)) return { result: '△', isExact: false }
  // 1文字以上共通
  const caChars = new Set(ca.split(''))
  const uaChars = new Set(ua.split(''))
  const common = [...caChars].filter(c => uaChars.has(c))
  if (common.length >= 1 && common.length >= Math.min(caChars.size, uaChars.size) * 0.4) {
    return { result: '△', isExact: false }
  }
  return { result: '×', isExact: false }
}

// ====== API: 回答判定 (AI + ルールベースフォールバック) ======
app.post('/api/judge', async (c) => {
  const body = await c.req.json()
  const { question, correctAnswer, userAnswer } = body

  if (!question || !correctAnswer || !userAnswer) {
    return c.json({ error: 'Missing fields' }, 400)
  }

  const apiKey = c.env?.OPENAI_API_KEY || ''
  const baseUrl = c.env?.OPENAI_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1'

  const prompt = `あなたはなぞなぞの回答を判定する審判です。

なぞなぞの問題: ${question}
正しい答え: ${correctAnswer}
ユーザーの回答: ${userAnswer}

判定基準:
- ○ (完全正解): 正しい答えと同じ意味・内容（表記違い・ひらがな/カタカナ/漢字の差異は正解扱い）
- △ (部分正解): 答えの一部が合っている、または正解に近い考え方をしているが言葉が違う
- × (不正解): 答えと全く関係ない

JSONのみ返してください:
{"result":"○か△か×","hint":"△か×の場合のみ。答えを直接教えず、考え方の方向性だけを示す間接的ヒント（40字以内）。○の場合は空文字"}`

  // まずルールベースで判定（AI失敗時のフォールバック）
  const ruleFallback = ruleBasedJudge(correctAnswer, userAnswer)

  if (!apiKey) {
    // APIキーなし: ルールベースのみ
    const hint = ruleFallback.result !== '○'
      ? '答えの言葉をよく聞いてみよう。問題の言葉と答えに隠れた関係があるよ。'
      : ''
    return c.json({ result: ruleFallback.result, hint, mode: 'rule' })
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 200
      })
    })

    if (!res.ok) {
      // AI失敗: ルールベースで返す
      const hint = ruleFallback.result !== '○'
        ? '問題の言葉をよく分解して考えてみよう。'
        : ''
      return c.json({ result: ruleFallback.result, hint, mode: 'rule' })
    }

    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content || ''

    // クレジット不足チェック
    if (content.includes("credits") || content.includes("subscribe") || content.includes("pricing")) {
      const hint = ruleFallback.result !== '○'
        ? '問題の言葉をよく分解して考えてみよう。ダジャレが隠れているかも！'
        : ''
      return c.json({ result: ruleFallback.result, hint, mode: 'rule' })
    }

    const jsonMatch = content.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) {
      const hint = ruleFallback.result !== '○' ? '問題の言葉をよく分解して考えてみよう。' : ''
      return c.json({ result: ruleFallback.result, hint, mode: 'rule' })
    }

    const parsed = JSON.parse(jsonMatch[0])
    return c.json({
      result: parsed.result || ruleFallback.result,
      hint: parsed.hint || '',
      mode: 'ai'
    })
  } catch (e: any) {
    const hint = ruleFallback.result !== '○' ? '問題の言葉をよく分解して考えてみよう。' : ''
    return c.json({ result: ruleFallback.result, hint, mode: 'rule' })
  }
})

// ====== Pages ======
app.get('/', (c) => c.html(mainPage()))
app.get('/admin', (c) => c.html(adminPage()))

// ====== メインページ HTML ======
function mainPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>なぞなぞルーレット</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700;900&display=swap');
    * { font-family: 'Noto Sans JP', sans-serif; }
    body { background: #0a0a0a; color: #fff; min-height: 100vh; overflow-x: hidden; }

    .site-header {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      padding: 1.5rem 2rem; display: flex; justify-content: space-between; align-items: center;
      background: linear-gradient(to bottom, rgba(10,10,10,0.95), transparent);
    }
    .site-logo {
      font-size: 1.1rem; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase;
      background: linear-gradient(135deg, #f0e68c, #ffd700, #ff8c00);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .admin-link { font-size: 0.75rem; color: rgba(255,255,255,0.4); text-decoration: none; letter-spacing: 0.1em; transition: color 0.3s; }
    .admin-link:hover { color: rgba(255,255,255,0.8); }

    .hero {
      min-height: 100vh; display: flex; flex-direction: column; align-items: center;
      justify-content: center; position: relative; padding-top: 80px;
    }
    .hero-bg {
      position: absolute; inset: 0;
      background: radial-gradient(ellipse at 50% 40%, rgba(255,180,0,0.08) 0%, transparent 60%),
                  radial-gradient(ellipse at 80% 80%, rgba(255,80,120,0.06) 0%, transparent 50%),
                  radial-gradient(ellipse at 20% 80%, rgba(80,120,255,0.06) 0%, transparent 50%);
    }
    .hero-subtitle { font-size: 0.75rem; letter-spacing: 0.4em; text-transform: uppercase; color: rgba(255,180,0,0.8); margin-bottom: 1.5rem; }
    .hero-title { font-size: clamp(2.5rem, 8vw, 5rem); font-weight: 900; line-height: 1.1; text-align: center; margin-bottom: 1rem; letter-spacing: -0.02em; }
    .hero-desc { font-size: 1rem; color: rgba(255,255,255,0.5); text-align: center; max-width: 400px; line-height: 1.8; margin-bottom: 3rem; }

    .roulette-section { display: flex; flex-direction: column; align-items: center; gap: 2rem; width: 100%; max-width: 500px; position: relative; z-index: 1; }
    .roulette-wrapper { position: relative; width: 320px; height: 320px; }
    .roulette-canvas { border-radius: 50%; box-shadow: 0 0 60px rgba(255,180,0,0.2), 0 0 120px rgba(255,180,0,0.08); }
    .roulette-pointer {
      position: absolute; top: -18px; left: 50%; transform: translateX(-50%);
      width: 0; height: 0;
      border-left: 14px solid transparent; border-right: 14px solid transparent;
      border-top: 28px solid #ffd700; filter: drop-shadow(0 4px 8px rgba(255,215,0,0.8)); z-index: 10;
    }
    .roulette-center {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 40px; height: 40px; background: #0a0a0a; border-radius: 50%; border: 3px solid rgba(255,215,0,0.6); z-index: 10;
    }

    .spin-btn {
      position: relative; padding: 1rem 3rem; font-size: 1rem; font-weight: 700;
      letter-spacing: 0.15em; border: none; border-radius: 2px; cursor: pointer;
      overflow: hidden; transition: all 0.3s; background: linear-gradient(135deg, #ffd700, #ff8c00); color: #0a0a0a;
    }
    .spin-btn:before { content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent); transition: left 0.5s; }
    .spin-btn:hover:before { left: 100%; }
    .spin-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(255,180,0,0.4); }
    .spin-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    .result-label { font-size: 0.9rem; letter-spacing: 0.2em; color: rgba(255,255,255,0.5); min-height: 1.5rem; text-align: center; }
    .result-label.active { color: #ffd700; }

    .quiz-section { width: 100%; max-width: 700px; margin: 0 auto; padding: 0 1.5rem 6rem; }
    .quiz-card {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 2px;
      overflow: hidden; transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1); opacity: 0; transform: translateY(30px);
    }
    .quiz-card.visible { opacity: 1; transform: translateY(0); }
    .quiz-card-header {
      padding: 1.5rem 2rem; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 1rem;
    }
    .difficulty-badge { font-size: 0.65rem; letter-spacing: 0.15em; font-weight: 700; padding: 0.25rem 0.75rem; border-radius: 1px; }
    .diff-very-easy { background: rgba(100,200,100,0.2); color: #64c864; border: 1px solid rgba(100,200,100,0.3); }
    .diff-easy { background: rgba(100,180,255,0.2); color: #64b4ff; border: 1px solid rgba(100,180,255,0.3); }
    .diff-normal { background: rgba(255,200,100,0.2); color: #ffc864; border: 1px solid rgba(255,200,100,0.3); }
    .diff-hard { background: rgba(255,80,80,0.2); color: #ff5050; border: 1px solid rgba(255,80,80,0.3); }

    .quiz-number { font-size: 0.7rem; color: rgba(255,255,255,0.3); letter-spacing: 0.1em; }
    .quiz-image { width: 100%; max-height: 240px; object-fit: cover; display: block; filter: brightness(0.8); }
    .quiz-body { padding: 2rem; }
    .quiz-question { font-size: clamp(1.1rem, 3vw, 1.4rem); font-weight: 700; line-height: 1.7; margin-bottom: 2rem; color: rgba(255,255,255,0.95); }

    /* ===== 答え入力エリア ===== */
    .answer-input-section { margin-bottom: 1.5rem; }
    .answer-input-label { font-size: 0.7rem; letter-spacing: 0.2em; color: rgba(255,255,255,0.4); margin-bottom: 0.5rem; display: block; }
    .answer-input-row { display: flex; gap: 0.75rem; align-items: stretch; }
    .answer-input {
      flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      color: #fff; padding: 0.9rem 1.2rem; font-size: 1rem; font-weight: 500; border-radius: 2px;
      outline: none; transition: border-color 0.2s;
    }
    .answer-input:focus { border-color: rgba(255,215,0,0.5); background: rgba(255,215,0,0.04); }
    .answer-input::placeholder { color: rgba(255,255,255,0.25); }
    .judge-btn {
      padding: 0.9rem 1.5rem; background: linear-gradient(135deg, #ffd700, #ff8c00);
      color: #0a0a0a; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em;
      border: none; border-radius: 2px; cursor: pointer; transition: all 0.2s; white-space: nowrap;
    }
    .judge-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(255,180,0,0.4); }
    .judge-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    /* ===== 判定結果 ===== */
    .judge-result {
      margin-top: 1rem; padding: 1.25rem 1.5rem; border-radius: 2px;
      display: none; animation: fadeSlideIn 0.4s cubic-bezier(0.16,1,0.3,1);
    }
    .judge-result.show { display: block; }
    @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    .judge-result.correct { background: rgba(100,200,100,0.1); border: 1px solid rgba(100,200,100,0.3); }
    .judge-result.partial { background: rgba(255,200,100,0.1); border: 1px solid rgba(255,200,100,0.3); }
    .judge-result.wrong   { background: rgba(255,80,80,0.1);  border: 1px solid rgba(255,80,80,0.3);  }

    .judge-mark {
      font-size: 2.5rem; line-height: 1; display: block; margin-bottom: 0.5rem;
      animation: popIn 0.5s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes popIn { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .judge-mark.correct-mark { color: #64c864; }
    .judge-mark.partial-mark { color: #ffc864; }
    .judge-mark.wrong-mark   { color: #ff5050; }

    .judge-message { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.3rem; }
    .judge-message.correct-msg { color: #64c864; }
    .judge-message.partial-msg { color: #ffc864; }
    .judge-message.wrong-msg   { color: #ff5050; }

    .judge-hint { font-size: 0.85rem; color: rgba(255,255,255,0.6); line-height: 1.7; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); }
    .judge-hint-label { font-size: 0.65rem; letter-spacing: 0.15em; color: rgba(255,180,0,0.6); margin-bottom: 0.25rem; }

    /* ===== ヒント・答え表示 ===== */
    .action-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1.5rem; }
    .reveal-btn {
      flex: 1; min-width: 140px; padding: 0.9rem 1.5rem; font-size: 0.85rem; font-weight: 600;
      letter-spacing: 0.1em; border: 1px solid rgba(255,255,255,0.15); background: transparent;
      color: rgba(255,255,255,0.7); cursor: pointer; transition: all 0.2s; border-radius: 1px;
    }
    .reveal-btn:hover { border-color: rgba(255,215,0,0.5); color: #ffd700; background: rgba(255,215,0,0.05); }
    .answer-reveal { margin-top: 1.5rem; overflow: hidden; max-height: 0; transition: max-height 0.5s cubic-bezier(0.16,1,0.3,1), opacity 0.3s; opacity: 0; }
    .answer-reveal.open { max-height: 500px; opacity: 1; }
    .answer-box { background: rgba(255,215,0,0.06); border: 1px solid rgba(255,215,0,0.15); border-radius: 1px; padding: 1.5rem 2rem; margin-bottom: 1rem; }
    .answer-label { font-size: 0.65rem; letter-spacing: 0.2em; color: rgba(255,215,0,0.6); margin-bottom: 0.5rem; font-weight: 700; }
    .answer-text { font-size: 1.5rem; font-weight: 900; color: #ffd700; }
    .hint-box { background: rgba(100,180,255,0.05); border: 1px solid rgba(100,180,255,0.15); border-radius: 1px; padding: 1.25rem 2rem; margin-top: 1rem; }
    .hint-label { font-size: 0.65rem; letter-spacing: 0.2em; color: rgba(100,180,255,0.6); margin-bottom: 0.5rem; font-weight: 700; }
    .hint-text { font-size: 0.95rem; color: rgba(255,255,255,0.7); line-height: 1.7; }

    .next-quiz-btn {
      display: block; width: 100%; padding: 1.2rem; margin-top: 2rem;
      font-size: 0.85rem; font-weight: 600; letter-spacing: 0.2em;
      background: transparent; border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.3s; border-radius: 1px;
    }
    .next-quiz-btn:hover { border-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.9); }

    .loading-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #ffd700; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 0.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .particle { position: fixed; pointer-events: none; width: 6px; height: 6px; border-radius: 50%; animation: particleFall 2s ease-out forwards; }
    @keyframes particleFall { 0% { opacity: 1; transform: translate(0,0) rotate(0deg) scale(1); } 100% { opacity: 0; transform: translate(var(--tx), var(--ty)) rotate(720deg) scale(0); } }

    @media (max-width: 640px) {
      .roulette-wrapper { width: 280px; height: 280px; }
      .site-header { padding: 1rem 1.5rem; }
      .answer-input-row { flex-direction: column; }
      .judge-btn { width: 100%; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="site-logo">🎯 NAZO ROULETTE</div>
    <a href="/admin" class="admin-link">ADMIN ↗</a>
  </header>

  <section class="hero" id="hero-section">
    <div class="hero-bg"></div>
    <div class="roulette-section" id="roulette-section">
      <p class="hero-subtitle">Spin to Start</p>
      <h1 class="hero-title">なぞなぞ<br>ルーレット</h1>
      <p class="hero-desc">ルーレットを回して難易度を決めよう。<br>なぞなぞをランダム出題。</p>

      <div class="roulette-wrapper">
        <div class="roulette-pointer"></div>
        <canvas id="roulette-canvas" class="roulette-canvas" width="320" height="320"></canvas>
        <div class="roulette-center"></div>
      </div>

      <div class="result-label" id="result-label">ルーレットを回して難易度を決定しよう</div>
      <button class="spin-btn" id="spin-btn" onclick="spinRoulette()">SPIN</button>
    </div>
  </section>

  <section class="quiz-section" id="quiz-section">
    <div class="quiz-card" id="quiz-card">
      <div class="quiz-card-header">
        <span class="difficulty-badge" id="quiz-difficulty-badge">EASY</span>
        <span class="quiz-number" id="quiz-number">QUIZ #001</span>
      </div>
      <img src="" alt="" id="quiz-image" class="quiz-image" style="display:none">
      <div class="quiz-body">
        <div class="quiz-question" id="quiz-question">問題を読み込み中...</div>

        <!-- 答え入力エリア -->
        <div class="answer-input-section">
          <span class="answer-input-label">YOUR ANSWER</span>
          <div class="answer-input-row">
            <input type="text" class="answer-input" id="user-answer-input"
              placeholder="答えを入力してみよう..."
              onkeydown="if(event.key==='Enter') judgeAnswer()">
            <button class="judge-btn" id="judge-btn" onclick="judgeAnswer()">
              <i class="fas fa-check"></i> 判定
            </button>
          </div>
        </div>

        <!-- AI判定結果 -->
        <div class="judge-result" id="judge-result">
          <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem;">
            <span class="judge-mark" id="judge-mark">○</span>
            <div>
              <div class="judge-message" id="judge-message">正解！</div>
              <button id="retry-btn" onclick="retryAnswer()" style="display:none;margin-top:0.3rem;font-size:0.72rem;color:rgba(255,215,0,0.7);background:transparent;border:1px solid rgba(255,215,0,0.3);padding:0.2rem 0.6rem;border-radius:2px;cursor:pointer;letter-spacing:0.05em;">↩ もう一度入力</button>
            </div>
          </div>
          <div class="judge-hint" id="judge-hint-wrap" style="display:none">
            <div class="judge-hint-label">HINT TO ○</div>
            <div id="judge-hint-text"></div>
          </div>
        </div>

        <!-- ヒント・答え表示 -->
        <div class="action-row">
          <button class="reveal-btn" id="hint-btn" onclick="toggleHint()">
            <i class="fas fa-lightbulb mr-2"></i>ヒントを見る
          </button>
          <button class="reveal-btn" id="answer-btn" onclick="toggleAnswer()">
            <i class="fas fa-eye mr-2"></i>答えを見る
          </button>
        </div>

        <div class="answer-reveal" id="hint-reveal">
          <div class="hint-box">
            <div class="hint-label">HINT</div>
            <div class="hint-text" id="hint-text">ヒントなし</div>
          </div>
        </div>
        <div class="answer-reveal" id="answer-reveal">
          <div class="answer-box">
            <div class="answer-label">ANSWER</div>
            <div class="answer-text" id="answer-text">---</div>
          </div>
        </div>

        <button class="next-quiz-btn" onclick="nextQuiz()">
          <i class="fas fa-redo mr-2"></i>もう一度ルーレットを回す
        </button>
      </div>
    </div>
  </section>

<script>
// ====== 設定読み込み ======
const DIFFICULTIES = [
  { key: 'very-easy', label: 'やさしい',  color: '#2d6a2d', textColor: '#a3e6a3' },
  { key: 'easy',      label: 'かんたん',  color: '#1a3a6a', textColor: '#7ab8f5' },
  { key: 'normal',    label: 'ふつう',    color: '#5a4a00', textColor: '#ffd060' },
  { key: 'hard',      label: 'むずかしい',color: '#6a1a1a', textColor: '#f57070' },
];

// 管理設定: mode か weights を読む
let adminMode = 'random';      // 'very-easy'|'easy'|'normal'|'hard'|'random'
let adminWeights = { 'very-easy': 1, 'easy': 1, 'normal': 1, 'hard': 1 }; // 比率（常に4等分描画、確率制御のみ）

function loadAdminSettings() {
  const params = new URLSearchParams(window.location.search);
  const urlMode = params.get('mode');
  if (urlMode && ['very-easy','easy','normal','hard'].includes(urlMode)) {
    adminMode = urlMode;
    return;
  }
  // URLに重みがあれば取得
  let hasUrlWeights = false;
  const uw = {};
  DIFFICULTIES.forEach(d => {
    const v = parseFloat(params.get(d.key) || '0');
    if (v > 0) { uw[d.key] = v; hasUrlWeights = true; }
  });
  if (hasUrlWeights) { adminWeights = uw; adminMode = 'random'; return; }

  // localStorage
  try {
    const m = localStorage.getItem('roulette_mode');
    if (m) { adminMode = m; }
    const w = localStorage.getItem('roulette_weights');
    if (w) adminWeights = JSON.parse(w);
  } catch(e) {}
}
loadAdminSettings();

// ====== ルーレット描画（常に4等分） ======
const canvas = document.getElementById('roulette-canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const CX = W/2, CY = H/2, R = W/2 - 4;
const SLICE_ANGLE = Math.PI / 2; // 常に90度ずつ

function drawRoulette(rotation = 0) {
  ctx.clearRect(0, 0, W, H);
  DIFFICULTIES.forEach((d, i) => {
    const startAngle = rotation + i * SLICE_ANGLE - Math.PI/2;
    const endAngle = startAngle + SLICE_ANGLE;

    // スライス
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();
    const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, R);
    grad.addColorStop(0, lightenColor(d.color, 30));
    grad.addColorStop(1, d.color);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ラベル（常に読みやすい向きに）
    const midAngle = startAngle + SLICE_ANGLE / 2;
    ctx.save();
    ctx.translate(CX + Math.cos(midAngle) * R * 0.60, CY + Math.sin(midAngle) * R * 0.60);
    // 文字が常に外向きで読めるよう、上半分と下半分で回転を調整
    let textRot = midAngle + Math.PI / 2;
    ctx.rotate(textRot);
    ctx.fillStyle = d.textColor;
    ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.label, 0, 0);
    ctx.restore();
  });

  // 外枠
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,215,0,0.3)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return \`rgb(\${r},\${g},\${b})\`;
}

drawRoulette();

// ====== スピン ======
let isSpinning = false;
let currentCategory = null;
let quizCount = 0;
let currentQuiz = null;

function spinRoulette() {
  if (isSpinning) return;
  isSpinning = true;
  const btn = document.getElementById('spin-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span>SPINNING...';
  document.getElementById('result-label').className = 'result-label';
  document.getElementById('result-label').textContent = '';

  // 当選難易度決定
  let winKey;
  if (adminMode !== 'random') {
    // 固定モード: 必ずその難易度に止まる
    winKey = adminMode;
  } else {
    // 重み付きランダム
    winKey = weightedRandom();
  }

  const winIdx = DIFFICULTIES.findIndex(d => d.key === winKey);

  // ====== 停止位置の計算 ======
  // Canvas arc() の基準: angle=0 が右(3時), 反時計は負, 時計は正
  // ポインターは真上 = 3π/2 (270deg, ≡ -π/2)
  // drawRoulette(r) でのスライスiの中央角:
  //   midAngle = r + i*(π/2) - π/2 + π/4
  //            = r + i*(π/2) - π/4
  // 中央がポインター(3π/2)に来る条件:
  //   r + i*(π/2) - π/4 ≡ 3π/2  (mod 2π)
  //   r ≡ 7π/4 - i*(π/2)        (mod 2π)
  const TWO_PI = Math.PI * 2;
  const finalRot = ((7 * Math.PI / 4 - winIdx * SLICE_ANGLE) % TWO_PI + TWO_PI) % TWO_PI;

  // 必ず正方向に5〜8周してから finalRot に止まる
  // アニメーション中は生の値(MODなし)を使うことで逆ジャンプを防ぐ
  const extraSpins = (5 + Math.random() * 3) * TWO_PI;
  const totalRotation = extraSpins + finalRot; // 単調増加する回転量

  const duration = 4000 + Math.random() * 1000;
  const startTime = performance.now();

  function animate(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    // ※ %2π を取らず生の値をそのまま渡す → Canvas arc() は大きな角度も正しく処理
    drawRoulette(totalRotation * eased);
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // 最終位置: finalRot で正確に止める
      drawRoulette(finalRot);
      onSpinComplete(DIFFICULTIES[winIdx]);
    }
  }
  requestAnimationFrame(animate);
}

function weightedRandom() {
  const total = DIFFICULTIES.reduce((s, d) => s + (adminWeights[d.key] || 1), 0);
  let r = Math.random() * total;
  for (const d of DIFFICULTIES) {
    r -= (adminWeights[d.key] || 1);
    if (r <= 0) return d.key;
  }
  return DIFFICULTIES[DIFFICULTIES.length - 1].key;
}

function onSpinComplete(slice) {
  isSpinning = false;
  currentCategory = slice.key;
  createParticles();

  const labelEl = document.getElementById('result-label');
  labelEl.className = 'result-label active';
  const names = { 'very-easy':'⭐ やさしい','easy':'⭐⭐ かんたん','normal':'⭐⭐⭐ ふつう','hard':'⭐⭐⭐⭐ むずかしい' };
  labelEl.textContent = (names[slice.key] || slice.label) + ' に決定！';

  fetchQuiz(slice.key);
}

// ====== パーティクル ======
function createParticles() {
  const colors = ['#ffd700','#ff8c00','#ff5050','#64c864','#7ab8f5','#ff69b4'];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = \`left:\${40+Math.random()*20}%;top:40%;background:\${colors[Math.floor(Math.random()*colors.length)]};--tx:\${(Math.random()-0.5)*400}px;--ty:\${Math.random()*300+100}px;animation-delay:\${Math.random()*0.5}s;\`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2500);
  }
}

// ====== 問題取得 ======
async function fetchQuiz(category) {
  const btn = document.getElementById('spin-btn');
  btn.innerHTML = '<span class="loading-spinner"></span>問題取得中...';

  resetQuizUI();

  try {
    const res = await fetch(\`/api/quiz?category=\${category}\`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentQuiz = data;
    quizCount++;
    displayQuiz(data);
    setTimeout(() => {
      document.getElementById('quiz-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  } catch(e) {
    document.getElementById('quiz-question').textContent = '問題の取得に失敗しました。もう一度お試しください。';
    document.getElementById('quiz-card').classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'SPIN';
  }
}

function resetQuizUI() {
  document.getElementById('quiz-card').classList.remove('visible');
  document.getElementById('hint-reveal').classList.remove('open');
  document.getElementById('answer-reveal').classList.remove('open');
  document.getElementById('hint-btn').innerHTML = '<i class="fas fa-lightbulb mr-2"></i>ヒントを見る';
  document.getElementById('answer-btn').innerHTML = '<i class="fas fa-eye mr-2"></i>答えを見る';
  document.getElementById('user-answer-input').value = '';
  document.getElementById('judge-result').className = 'judge-result';
  document.getElementById('judge-btn').disabled = false;
  document.getElementById('judge-btn').innerHTML = '<i class="fas fa-check"></i> 判定';
}

function displayQuiz(data) {
  const diffMap = {
    'very-easy': { label:'VERY EASY', cls:'diff-very-easy' },
    'easy':      { label:'EASY',      cls:'diff-easy' },
    'normal':    { label:'NORMAL',    cls:'diff-normal' },
    'hard':      { label:'HARD',      cls:'diff-hard' },
  };
  const diff = diffMap[data.category] || diffMap['easy'];
  const badge = document.getElementById('quiz-difficulty-badge');
  badge.textContent = diff.label;
  badge.className = 'difficulty-badge ' + diff.cls;
  document.getElementById('quiz-number').textContent = 'QUIZ #' + String(quizCount).padStart(3,'0');
  document.getElementById('quiz-question').textContent = data.question;
  document.getElementById('answer-text').textContent = data.answer || '（答えが見つかりませんでした）';
  document.getElementById('hint-text').textContent = data.hint || 'ヒントはありません';

  const img = document.getElementById('quiz-image');
  if (data.imageUrl) {
    img.src = data.imageUrl; img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  } else {
    img.style.display = 'none';
  }

  setTimeout(() => document.getElementById('quiz-card').classList.add('visible'), 100);
  // 入力にフォーカス
  setTimeout(() => document.getElementById('user-answer-input').focus(), 600);
}

// ====== AI 回答判定 ======
async function judgeAnswer() {
  if (!currentQuiz) return;
  const userAnswer = document.getElementById('user-answer-input').value.trim();
  if (!userAnswer) {
    document.getElementById('user-answer-input').focus();
    return;
  }

  const judgeBtn = document.getElementById('judge-btn');
  judgeBtn.disabled = true;
  judgeBtn.innerHTML = '<span class="loading-spinner"></span>';

  try {
    const res = await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: currentQuiz.question,
        correctAnswer: currentQuiz.answer,
        userAnswer: userAnswer
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showJudgeResult(data.result, data.hint);
  } catch(e) {
    showJudgeResult('×', 'AI判定でエラーが発生しました。');
  } finally {
    judgeBtn.disabled = false;
    judgeBtn.innerHTML = '<i class="fas fa-check"></i> 判定';
  }
}

function showJudgeResult(result, hint) {
  const el = document.getElementById('judge-result');
  const mark = document.getElementById('judge-mark');
  const msg = document.getElementById('judge-message');
  const hintWrap = document.getElementById('judge-hint-wrap');
  const hintText = document.getElementById('judge-hint-text');

  el.className = 'judge-result show';

  if (result === '○') {
    el.classList.add('correct');
    mark.className = 'judge-mark correct-mark';
    mark.textContent = '○';
    msg.className = 'judge-message correct-msg';
    msg.textContent = '正解！素晴らしい！';
    hintWrap.style.display = 'none';
  } else if (result === '△') {
    el.classList.add('partial');
    mark.className = 'judge-mark partial-mark';
    mark.textContent = '△';
    msg.className = 'judge-message partial-msg';
    msg.textContent = '惜しい！もう少し！';
    if (hint) {
      hintWrap.style.display = 'block';
      hintText.textContent = hint;
    } else { hintWrap.style.display = 'none'; }
  } else {
    el.classList.add('wrong');
    mark.className = 'judge-mark wrong-mark';
    mark.textContent = '×';
    msg.className = 'judge-message wrong-msg';
    msg.textContent = 'ちがうよ、もう一度考えてみよう！';
    if (hint) {
      hintWrap.style.display = 'block';
      hintText.textContent = hint;
    } else { hintWrap.style.display = 'none'; }
  }

  // 再チャレンジ: △/×のときはretryボタン表示
  const retryBtn = document.getElementById('retry-btn');
  if (result !== '○') {
    retryBtn.style.display = 'inline-block';
    setTimeout(() => {
      document.getElementById('user-answer-input').select();
    }, 500);
  } else {
    retryBtn.style.display = 'none';
  }
}

function retryAnswer() {
  const input = document.getElementById('user-answer-input');
  input.value = '';
  document.getElementById('judge-result').className = 'judge-result';
  document.getElementById('judge-btn').disabled = false;
  document.getElementById('judge-btn').innerHTML = '<i class="fas fa-check"></i> 判定';
  input.focus();
}

function toggleHint() {
  const reveal = document.getElementById('hint-reveal');
  const btn = document.getElementById('hint-btn');
  reveal.classList.toggle('open');
  btn.innerHTML = reveal.classList.contains('open')
    ? '<i class="fas fa-lightbulb mr-2"></i>ヒントを隠す'
    : '<i class="fas fa-lightbulb mr-2"></i>ヒントを見る';
}

function toggleAnswer() {
  const reveal = document.getElementById('answer-reveal');
  const btn = document.getElementById('answer-btn');
  reveal.classList.toggle('open');
  btn.innerHTML = reveal.classList.contains('open')
    ? '<i class="fas fa-eye-slash mr-2"></i>答えを隠す'
    : '<i class="fas fa-eye mr-2"></i>答えを見る';
}

function nextQuiz() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('quiz-card').classList.remove('visible');
  document.getElementById('result-label').textContent = 'ルーレットを回して難易度を決定しよう';
  document.getElementById('result-label').className = 'result-label';
  currentQuiz = null;
}
</script>
</body>
</html>`
}

// ====== 管理ページ HTML ======
function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理画面 - なぞなぞルーレット</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700;900&display=swap');
    * { font-family: 'Noto Sans JP', sans-serif; }
    body { background: #0a0a0a; color: #fff; min-height: 100vh; }

    .admin-header { padding: 2rem; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 1rem; }
    .back-link { color: rgba(255,255,255,0.4); text-decoration: none; font-size: 0.8rem; letter-spacing: 0.1em; transition: color 0.2s; }
    .back-link:hover { color: #ffd700; }
    .admin-title { font-size: 1.2rem; font-weight: 900; letter-spacing: 0.1em; background: linear-gradient(135deg, #f0e68c, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }

    .admin-body { max-width: 800px; margin: 0 auto; padding: 3rem 2rem; }
    .section-title { font-size: 0.7rem; letter-spacing: 0.3em; text-transform: uppercase; color: rgba(255,215,0,0.6); margin-bottom: 1.5rem; padding-bottom: 0.75rem; border-bottom: 1px solid rgba(255,215,0,0.1); }

    /* モードカード */
    .mode-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 3rem; }
    .mode-card { padding: 1.5rem 1rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 2px; cursor: pointer; transition: all 0.2s; text-align: center; background: rgba(255,255,255,0.02); }
    .mode-card:hover { border-color: rgba(255,215,0,0.3); background: rgba(255,215,0,0.04); }
    .mode-card.active { border-color: rgba(255,215,0,0.6); background: rgba(255,215,0,0.08); }
    .mode-icon { font-size: 1.8rem; margin-bottom: 0.75rem; display: block; }
    .mode-label { font-size: 0.85rem; font-weight: 700; margin-bottom: 0.25rem; }
    .mode-desc { font-size: 0.68rem; color: rgba(255,255,255,0.4); line-height: 1.4; }

    /* プレビューとスライダー */
    .preview-slider-row { display: flex; gap: 2rem; align-items: flex-start; margin-bottom: 2rem; }
    .roulette-preview-col { flex-shrink: 0; text-align: center; }
    .roulette-preview-wrap { display: flex; justify-content: center; position: relative; }
    .roulette-preview { border-radius: 50%; box-shadow: 0 0 40px rgba(255,215,0,0.15); }
    .preview-pointer {
      position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
      width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent;
      border-top: 16px solid #ffd700; filter: drop-shadow(0 2px 4px rgba(255,215,0,0.8)); z-index: 10;
    }
    .preview-note { font-size: 0.65rem; color: rgba(255,255,255,0.35); margin-top: 0.75rem; letter-spacing: 0.05em; }

    .slider-col { flex: 1; }
    .weight-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
    .weight-label { width: 110px; flex-shrink: 0; }
    .weight-name { font-size: 0.85rem; font-weight: 600; }
    .weight-value { font-size: 0.68rem; color: rgba(255,255,255,0.4); }
    .weight-slider { flex: 1; -webkit-appearance: none; height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; }
    .weight-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #ffd700; cursor: pointer; box-shadow: 0 0 8px rgba(255,215,0,0.5); }
    .weight-num { width: 45px; text-align: right; font-size: 0.9rem; font-weight: 700; color: #ffd700; }

    /* 注釈 */
    .note-box { background: rgba(255,215,0,0.05); border: 1px solid rgba(255,215,0,0.12); border-radius: 2px; padding: 1rem 1.5rem; margin-bottom: 2rem; font-size: 0.8rem; color: rgba(255,255,255,0.5); line-height: 1.7; }
    .note-box b { color: rgba(255,215,0,0.7); }

    .apply-btn { display: block; width: 100%; padding: 1.2rem; background: linear-gradient(135deg, #ffd700, #ff8c00); color: #0a0a0a; font-size: 1rem; font-weight: 700; letter-spacing: 0.15em; border: none; border-radius: 2px; cursor: pointer; transition: all 0.3s; margin-bottom: 1rem; }
    .apply-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(255,180,0,0.4); }

    .copy-link-box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 2px; padding: 1rem 1.5rem; display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
    .copy-link-url { flex: 1; font-size: 0.75rem; color: rgba(255,255,255,0.4); word-break: break-all; font-family: monospace; }
    .copy-btn { padding: 0.5rem 1rem; background: transparent; border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.6); font-size: 0.75rem; cursor: pointer; border-radius: 1px; transition: all 0.2s; white-space: nowrap; }
    .copy-btn:hover { border-color: #ffd700; color: #ffd700; }

    .go-btn { display: block; text-align: center; padding: 1rem; margin-top: 1.5rem; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.7); text-decoration: none; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.1em; border-radius: 1px; transition: all 0.3s; }
    .go-btn:hover { border-color: rgba(255,215,0,0.5); color: #ffd700; }

    .status-msg { text-align: center; font-size: 0.8rem; color: #64c864; padding: 0.5rem; min-height: 1.5rem; }

    @media (max-width: 640px) {
      .preview-slider-row { flex-direction: column; }
      .mode-grid { grid-template-columns: repeat(3, 1fr); }
    }
  </style>
</head>
<body>
  <header class="admin-header">
    <a href="/" class="back-link">← BACK</a>
    <div class="admin-title">⚙ ADMIN — ルーレット設定</div>
  </header>

  <div class="admin-body">

    <div class="section-title">難易度モード</div>
    <div class="mode-grid" id="mode-grid">
      <div class="mode-card" data-mode="very-easy" onclick="setMode('very-easy')">
        <span class="mode-icon">⭐</span>
        <div class="mode-label" style="color:#a3e6a3">やさしい</div>
        <div class="mode-desc">必ずVERY EASY<br>で止まる</div>
      </div>
      <div class="mode-card" data-mode="easy" onclick="setMode('easy')">
        <span class="mode-icon">⭐⭐</span>
        <div class="mode-label" style="color:#7ab8f5">かんたん</div>
        <div class="mode-desc">必ずEASY<br>で止まる</div>
      </div>
      <div class="mode-card" data-mode="normal" onclick="setMode('normal')">
        <span class="mode-icon">⭐⭐⭐</span>
        <div class="mode-label" style="color:#ffc864">ふつう</div>
        <div class="mode-desc">必ずNORMAL<br>で止まる</div>
      </div>
      <div class="mode-card" data-mode="hard" onclick="setMode('hard')">
        <span class="mode-icon">⭐⭐⭐⭐</span>
        <div class="mode-label" style="color:#f57070">むずかしい</div>
        <div class="mode-desc">必ずHARD<br>で止まる</div>
      </div>
      <div class="mode-card active" data-mode="random" onclick="setMode('random')">
        <span class="mode-icon">🎲</span>
        <div class="mode-label" style="color:#ffd700">おまかせ</div>
        <div class="mode-desc">確率を<br>カスタム設定</div>
      </div>
    </div>

    <!-- 確率スライダー（おまかせ時のみ有効） -->
    <div id="weight-section">
      <div class="section-title">出現確率の調整（おまかせモード）</div>

      <div class="note-box">
        <b>📌 ルーレットは常に4等分で表示されます。</b><br>
        確率を変えても見た目は4等分のまま。スライダーの数値が高いほど<b>その難易度に止まりやすく</b>なります。
      </div>

      <div class="preview-slider-row">
        <!-- ルーレットプレビュー -->
        <div class="roulette-preview-col">
          <div class="roulette-preview-wrap">
            <div class="preview-pointer"></div>
            <canvas id="admin-roulette" class="roulette-preview" width="200" height="200"></canvas>
          </div>
          <div class="preview-note">※常に4等分表示</div>
        </div>

        <!-- スライダー -->
        <div class="slider-col">
          <div class="weight-row">
            <div class="weight-label">
              <div class="weight-name" style="color:#a3e6a3">やさしい</div>
              <div class="weight-value">VERY EASY</div>
            </div>
            <input type="range" class="weight-slider" id="w-very-easy" min="1" max="10" value="1" oninput="updateWeights()" style="accent-color:#a3e6a3">
            <div class="weight-num" id="wn-very-easy">1</div>
          </div>
          <div class="weight-row">
            <div class="weight-label">
              <div class="weight-name" style="color:#7ab8f5">かんたん</div>
              <div class="weight-value">EASY</div>
            </div>
            <input type="range" class="weight-slider" id="w-easy" min="1" max="10" value="1" oninput="updateWeights()" style="accent-color:#7ab8f5">
            <div class="weight-num" id="wn-easy">1</div>
          </div>
          <div class="weight-row">
            <div class="weight-label">
              <div class="weight-name" style="color:#ffc864">ふつう</div>
              <div class="weight-value">NORMAL</div>
            </div>
            <input type="range" class="weight-slider" id="w-normal" min="1" max="10" value="1" oninput="updateWeights()" style="accent-color:#ffc864">
            <div class="weight-num" id="wn-normal">1</div>
          </div>
          <div class="weight-row">
            <div class="weight-label">
              <div class="weight-name" style="color:#f57070">むずかしい</div>
              <div class="weight-value">HARD</div>
            </div>
            <input type="range" class="weight-slider" id="w-hard" min="1" max="10" value="1" oninput="updateWeights()" style="accent-color:#f57070">
            <div class="weight-num" id="wn-hard">1</div>
          </div>

          <!-- 確率表示 -->
          <div style="margin-top:1rem; padding:0.75rem 1rem; background:rgba(255,255,255,0.03); border-radius:2px; border:1px solid rgba(255,255,255,0.06);">
            <div style="font-size:0.65rem;letter-spacing:0.2em;color:rgba(255,215,0,0.5);margin-bottom:0.5rem;">推定出現確率</div>
            <div id="prob-display" style="font-size:0.8rem; color:rgba(255,255,255,0.5); line-height:1.8;"></div>
          </div>
        </div>
      </div>
    </div>

    <button class="apply-btn" onclick="applySettings()">
      <i class="fas fa-check mr-2"></i>設定を保存して適用
    </button>
    <div class="status-msg" id="status-msg"></div>

    <div class="copy-link-box">
      <div class="copy-link-url" id="share-url">設定を保存するとURLが生成されます</div>
      <button class="copy-btn" onclick="copyLink()"><i class="fas fa-copy mr-1"></i>コピー</button>
    </div>

    <a href="/" class="go-btn" id="go-display-link">
      <i class="fas fa-play mr-2"></i>表示サイトへ移動
    </a>
  </div>

<script>
const DIFFICULTIES = [
  { key: 'very-easy', label: 'やさしい',  color: '#2d6a2d', textColor: '#a3e6a3' },
  { key: 'easy',      label: 'かんたん',  color: '#1a3a6a', textColor: '#7ab8f5' },
  { key: 'normal',    label: 'ふつう',    color: '#5a4a00', textColor: '#ffd060' },
  { key: 'hard',      label: 'むずかしい',color: '#6a1a1a', textColor: '#f57070' },
];

let currentMode = 'random';
let weights = { 'very-easy': 1, 'easy': 1, 'normal': 1, 'hard': 1 };

function loadSettings() {
  try {
    const m = localStorage.getItem('roulette_mode');
    if (m) { currentMode = m; }
    const w = localStorage.getItem('roulette_weights');
    if (w) { weights = JSON.parse(w); }
  } catch(e) {}

  // UIに反映
  DIFFICULTIES.forEach(d => {
    const el = document.getElementById('w-' + d.key);
    if (el) el.value = weights[d.key] || 1;
  });
  setMode(currentMode, false);
}

function setMode(mode, save = true) {
  currentMode = mode;
  document.querySelectorAll('.mode-card').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  const weightSection = document.getElementById('weight-section');
  weightSection.style.opacity = mode === 'random' ? '1' : '0.4';
  weightSection.style.pointerEvents = mode === 'random' ? '' : 'none';

  updateWeights();
  if (save) updateShareUrl();
}

function updateWeights() {
  DIFFICULTIES.forEach(d => {
    const el = document.getElementById('w-' + d.key);
    if (el) {
      weights[d.key] = parseInt(el.value) || 1;
      document.getElementById('wn-' + d.key).textContent = weights[d.key];
    }
  });
  updateProbDisplay();
  drawAdminRoulette();
  updateShareUrl();
}

function updateProbDisplay() {
  const total = DIFFICULTIES.reduce((s, d) => s + (weights[d.key] || 1), 0);
  const el = document.getElementById('prob-display');
  if (!el) return;
  el.innerHTML = DIFFICULTIES.map(d => {
    const pct = Math.round((weights[d.key] || 1) / total * 100);
    return \`<span style="color:\${d.textColor}">\${d.label}</span>: <b style="color:#fff">\${pct}%</b>\`;
  }).join('　');
}

// Admin roulette (常に4等分)
const ac = document.getElementById('admin-roulette');
const actx = ac.getContext('2d');
const AW = ac.width, AH = ac.height;
const ACX = AW/2, ACY = AH/2, AR = AW/2 - 4;
const ASLICE = Math.PI / 2;

function drawAdminRoulette() {
  actx.clearRect(0, 0, AW, AH);
  DIFFICULTIES.forEach((d, i) => {
    const start = i * ASLICE - Math.PI/2;
    const end = start + ASLICE;
    actx.beginPath();
    actx.moveTo(ACX, ACY);
    actx.arc(ACX, ACY, AR, start, end);
    actx.closePath();
    const grad = actx.createRadialGradient(ACX, ACY, 0, ACX, ACY, AR);
    grad.addColorStop(0, lightenColor(d.color, 30));
    grad.addColorStop(1, d.color);
    actx.fillStyle = grad;
    actx.fill();
    actx.strokeStyle = 'rgba(255,255,255,0.1)';
    actx.lineWidth = 1;
    actx.stroke();

    const mid = start + ASLICE/2;
    actx.save();
    actx.translate(ACX + Math.cos(mid) * AR * 0.6, ACY + Math.sin(mid) * AR * 0.6);
    actx.rotate(mid + Math.PI/2);
    actx.fillStyle = d.textColor;
    actx.font = 'bold 10px "Noto Sans JP", sans-serif';
    actx.textAlign = 'center';
    actx.textBaseline = 'middle';
    actx.fillText(d.label, 0, 0);
    actx.restore();
  });
  actx.beginPath();
  actx.arc(ACX, ACY, AR, 0, Math.PI*2);
  actx.strokeStyle = 'rgba(255,215,0,0.3)';
  actx.lineWidth = 2;
  actx.stroke();
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return \`rgb(\${r},\${g},\${b})\`;
}

function updateShareUrl() {
  let url;
  if (currentMode !== 'random') {
    url = window.location.origin + '/?mode=' + currentMode;
  } else {
    const params = new URLSearchParams();
    DIFFICULTIES.forEach(d => { params.set(d.key, weights[d.key] || 1); });
    url = window.location.origin + '/?' + params.toString();
  }
  document.getElementById('share-url').textContent = url;
  document.getElementById('go-display-link').href = url.replace(window.location.origin, '');
}

function applySettings() {
  localStorage.setItem('roulette_mode', currentMode);
  localStorage.setItem('roulette_weights', JSON.stringify(weights));
  const msg = document.getElementById('status-msg');
  msg.textContent = '✓ 設定を保存しました';
  setTimeout(() => { msg.textContent = ''; }, 3000);
  updateShareUrl();
}

function copyLink() {
  const url = document.getElementById('share-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.innerHTML = '<i class="fas fa-check mr-1"></i>コピーしました';
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy mr-1"></i>コピー'; }, 2000);
  });
}

loadSettings();
</script>
</body>
</html>`
}

export default app
