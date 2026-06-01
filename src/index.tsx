import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.use('/api/*', cors())

// Favicon (inline SVG)
app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0a0a0a" stroke="#ffd700" stroke-width="2"/><text x="16" y="23" font-size="16" text-anchor="middle" fill="#ffd700">🎯</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})
app.get('/favicon.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0a0a0a" stroke="#ffd700" stroke-width="2"/><text x="16" y="23" font-size="16" text-anchor="middle" fill="#ffd700">🎯</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})

// ====== API: 記事一覧URLをスクレイピング ======
async function fetchArticleUrls(category: string, page: number = 1): Promise<string[]> {
  const url = `https://nazogaku.com/${category}/page/${page}/`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)',
        'Accept': 'text/html',
      }
    })
    if (!res.ok) return []
    const html = await res.text()
    const matches = html.matchAll(/href="(https:\/\/nazogaku\.com\/q\d+\/)"/g)
    const urls: string[] = []
    for (const m of matches) {
      if (!urls.includes(m[1])) urls.push(m[1])
    }
    return urls
  } catch {
    return []
  }
}

async function getLastPage(category: string): Promise<number> {
  const url = `https://nazogaku.com/${category}/`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)' }
    })
    if (!res.ok) return 1
    const html = await res.text()
    const pageMatches = html.matchAll(new RegExp(`"https://nazogaku\\.com/${category}/page/(\\d+)/"`, 'g'))
    let maxPage = 1
    for (const m of pageMatches) {
      const n = parseInt(m[1])
      if (n > maxPage) maxPage = n
    }
    return maxPage
  } catch {
    return 1
  }
}

// ====== API: 問題詳細スクレイピング ======
async function fetchQuizDetail(url: string): Promise<{ question: string; answer: string; hint: string; imageUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)' }
    })
    if (!res.ok) return null
    const html = await res.text()

    // descriptionメタタグから問題文を取得
    const descMatch = html.match(/<meta name="description" content="([^"]+)"/)
    let question = ''
    if (descMatch) {
      question = descMatch[1].replace(/^なぞなぞ[クイズ：\s]*：?\s*/, '').trim()
    }

    // post_contentから答えとヒントを抽出
    const pcStart = html.indexOf('class="post_content">')
    const pcEnd = html.indexOf('</article', pcStart)
    const postContent = pcStart !== -1 ? html.slice(pcStart, pcEnd !== -1 ? pcEnd : pcStart + 5000) : ''

    // ルビタグ除去して純テキスト化
    const cleanText = postContent
      .replace(/<ruby>/g, '')
      .replace(/<\/ruby>/g, '')
      .replace(/<rt>[^<]*<\/rt>/g, '')
      .replace(/<rp>[^<]*<\/rp>/g, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/\n+/g, '\n')
      .trim()

    const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0)

    // 答えの抽出: 「答えをみる」の後の行
    let answer = ''
    let hint = ''
    const answerIdx = lines.findIndex(l => l.includes('えをみる'))
    if (answerIdx !== -1 && answerIdx + 1 < lines.length) {
      answer = lines[answerIdx + 1]
      // 括弧の読みを除去
      answer = answer.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
    }

    // ヒントの抽出: 「なぞなぞ博士」の後の行
    const hintIdx = lines.findIndex(l => l.includes('博士'))
    if (hintIdx !== -1 && hintIdx + 1 < lines.length) {
      hint = lines[hintIdx + 1]
      hint = hint.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
    }

    // サムネイル画像URL
    const imgMatch = html.match(/thumbnailUrl":"(https:\/\/nazogaku\.com\/wp-content\/[^"]+)"/)
    const imageUrl = imgMatch ? imgMatch[1] : ''

    if (!question) return null
    return { question, answer, hint, imageUrl }
  } catch {
    return null
  }
}

// ====== API エンドポイント ======

// ランダム問題取得
app.get('/api/quiz', async (c) => {
  const category = c.req.query('category') || 'random'

  const categories = ['very-easy', 'easy', 'normal', 'hard']
  const selectedCategory = category === 'random'
    ? categories[Math.floor(Math.random() * categories.length)]
    : category

  if (!categories.includes(selectedCategory)) {
    return c.json({ error: 'Invalid category' }, 400)
  }

  try {
    // ランダムページを選択（最大29ページ）
    const maxPage = 29
    const randomPage = Math.floor(Math.random() * maxPage) + 1
    const urls = await fetchArticleUrls(selectedCategory, randomPage)

    if (urls.length === 0) {
      // フォールバック: 1ページ目
      const fallbackUrls = await fetchArticleUrls(selectedCategory, 1)
      if (fallbackUrls.length === 0) {
        return c.json({ error: 'Failed to fetch quiz list' }, 500)
      }
      const randomUrl = fallbackUrls[Math.floor(Math.random() * fallbackUrls.length)]
      const quiz = await fetchQuizDetail(randomUrl)
      if (!quiz) return c.json({ error: 'Failed to fetch quiz detail' }, 500)
      return c.json({ ...quiz, category: selectedCategory, sourceUrl: randomUrl })
    }

    const randomUrl = urls[Math.floor(Math.random() * urls.length)]
    const quiz = await fetchQuizDetail(randomUrl)
    if (!quiz) return c.json({ error: 'Failed to fetch quiz detail' }, 500)

    return c.json({ ...quiz, category: selectedCategory, sourceUrl: randomUrl })
  } catch (e) {
    return c.json({ error: 'Server error' }, 500)
  }
})

// 管理者設定保存・取得 (KVなし版: URLパラメータで渡す)
app.get('/api/roulette-weights', (c) => {
  // デフォルト均等
  return c.json({
    weights: { 'very-easy': 25, 'easy': 25, 'normal': 25, 'hard': 25 }
  })
})

// ====== フロントエンド ページ ======

// メイン表示ページ (/)
app.get('/', (c) => {
  return c.html(mainPage())
})

// 管理ページ (/admin)
app.get('/admin', (c) => {
  return c.html(adminPage())
})

// ====== HTML テンプレート ======

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
    
    body {
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ===== HEADER ===== */
    .site-header {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 100;
      padding: 1.5rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(to bottom, rgba(10,10,10,0.95), transparent);
    }
    .site-logo {
      font-size: 1.1rem;
      font-weight: 900;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      background: linear-gradient(135deg, #f0e68c, #ffd700, #ff8c00);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .admin-link {
      font-size: 0.75rem;
      color: rgba(255,255,255,0.4);
      text-decoration: none;
      letter-spacing: 0.1em;
      transition: color 0.3s;
    }
    .admin-link:hover { color: rgba(255,255,255,0.8); }

    /* ===== HERO ===== */
    .hero {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      padding-top: 80px;
    }
    .hero-bg {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 50% 40%, rgba(255,180,0,0.08) 0%, transparent 60%),
                  radial-gradient(ellipse at 80% 80%, rgba(255,80,120,0.06) 0%, transparent 50%),
                  radial-gradient(ellipse at 20% 80%, rgba(80,120,255,0.06) 0%, transparent 50%);
    }
    .hero-subtitle {
      font-size: 0.75rem;
      letter-spacing: 0.4em;
      text-transform: uppercase;
      color: rgba(255,180,0,0.8);
      margin-bottom: 1.5rem;
    }
    .hero-title {
      font-size: clamp(2.5rem, 8vw, 5rem);
      font-weight: 900;
      line-height: 1.1;
      text-align: center;
      margin-bottom: 1rem;
      letter-spacing: -0.02em;
    }
    .hero-desc {
      font-size: 1rem;
      color: rgba(255,255,255,0.5);
      text-align: center;
      max-width: 400px;
      line-height: 1.8;
      margin-bottom: 3rem;
    }

    /* ===== ROULETTE ===== */
    .roulette-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2rem;
      width: 100%;
      max-width: 500px;
      position: relative;
      z-index: 1;
    }
    .roulette-wrapper {
      position: relative;
      width: 320px;
      height: 320px;
    }
    .roulette-canvas {
      border-radius: 50%;
      box-shadow: 0 0 60px rgba(255,180,0,0.2), 0 0 120px rgba(255,180,0,0.08);
    }
    .roulette-pointer {
      position: absolute;
      top: -18px;
      left: 50%;
      transform: translateX(-50%);
      width: 0;
      height: 0;
      border-left: 14px solid transparent;
      border-right: 14px solid transparent;
      border-top: 28px solid #ffd700;
      filter: drop-shadow(0 4px 8px rgba(255,215,0,0.8));
      z-index: 10;
    }
    .roulette-center {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 40px; height: 40px;
      background: #0a0a0a;
      border-radius: 50%;
      border: 3px solid rgba(255,215,0,0.6);
      z-index: 10;
    }

    /* ===== SPIN BUTTON ===== */
    .spin-btn {
      position: relative;
      padding: 1rem 3rem;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.15em;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      overflow: hidden;
      transition: all 0.3s;
      background: linear-gradient(135deg, #ffd700, #ff8c00);
      color: #0a0a0a;
    }
    .spin-btn:before {
      content: '';
      position: absolute;
      top: 0; left: -100%;
      width: 100%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
      transition: left 0.5s;
    }
    .spin-btn:hover:before { left: 100%; }
    .spin-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(255,180,0,0.4); }
    .spin-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    /* ===== RESULT LABEL ===== */
    .result-label {
      font-size: 0.9rem;
      letter-spacing: 0.2em;
      color: rgba(255,255,255,0.5);
      min-height: 1.5rem;
      text-align: center;
    }
    .result-label.active { color: #ffd700; }

    /* ===== QUIZ SECTION ===== */
    .quiz-section {
      width: 100%;
      max-width: 700px;
      margin: 0 auto;
      padding: 0 1.5rem 6rem;
    }
    .quiz-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 2px;
      overflow: hidden;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      opacity: 0;
      transform: translateY(30px);
    }
    .quiz-card.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .quiz-card-header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .difficulty-badge {
      font-size: 0.65rem;
      letter-spacing: 0.15em;
      font-weight: 700;
      padding: 0.25rem 0.75rem;
      border-radius: 1px;
    }
    .diff-very-easy { background: rgba(100,200,100,0.2); color: #64c864; border: 1px solid rgba(100,200,100,0.3); }
    .diff-easy { background: rgba(100,180,255,0.2); color: #64b4ff; border: 1px solid rgba(100,180,255,0.3); }
    .diff-normal { background: rgba(255,200,100,0.2); color: #ffc864; border: 1px solid rgba(255,200,100,0.3); }
    .diff-hard { background: rgba(255,80,80,0.2); color: #ff5050; border: 1px solid rgba(255,80,80,0.3); }

    .quiz-number {
      font-size: 0.7rem;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.1em;
    }
    .quiz-image {
      width: 100%;
      max-height: 240px;
      object-fit: cover;
      display: block;
      filter: brightness(0.8);
    }
    .quiz-body {
      padding: 2rem;
    }
    .quiz-question {
      font-size: clamp(1.1rem, 3vw, 1.4rem);
      font-weight: 700;
      line-height: 1.7;
      margin-bottom: 2rem;
      color: rgba(255,255,255,0.95);
    }

    /* ===== ANSWER / HINT BUTTONS ===== */
    .action-row {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .reveal-btn {
      flex: 1;
      min-width: 140px;
      padding: 0.9rem 1.5rem;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      border: 1px solid rgba(255,255,255,0.15);
      background: transparent;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      transition: all 0.2s;
      border-radius: 1px;
    }
    .reveal-btn:hover {
      border-color: rgba(255,215,0,0.5);
      color: #ffd700;
      background: rgba(255,215,0,0.05);
    }
    .reveal-btn.shown {
      border-color: rgba(255,215,0,0.3);
      color: rgba(255,255,255,0.4);
      cursor: default;
    }
    .answer-reveal {
      margin-top: 1.5rem;
      overflow: hidden;
      max-height: 0;
      transition: max-height 0.5s cubic-bezier(0.16,1,0.3,1), opacity 0.3s;
      opacity: 0;
    }
    .answer-reveal.open {
      max-height: 500px;
      opacity: 1;
    }
    .answer-box {
      background: rgba(255,215,0,0.06);
      border: 1px solid rgba(255,215,0,0.15);
      border-radius: 1px;
      padding: 1.5rem 2rem;
      margin-bottom: 1rem;
    }
    .answer-label {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      color: rgba(255,215,0,0.6);
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    .answer-text {
      font-size: 1.5rem;
      font-weight: 900;
      color: #ffd700;
    }
    .hint-box {
      background: rgba(100,180,255,0.05);
      border: 1px solid rgba(100,180,255,0.15);
      border-radius: 1px;
      padding: 1.25rem 2rem;
      margin-top: 1rem;
    }
    .hint-label {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      color: rgba(100,180,255,0.6);
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    .hint-text {
      font-size: 0.95rem;
      color: rgba(255,255,255,0.7);
      line-height: 1.7;
    }

    /* ===== NEXT BUTTON ===== */
    .next-quiz-btn {
      display: block;
      width: 100%;
      padding: 1.2rem;
      margin-top: 2rem;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.2em;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5);
      cursor: pointer;
      transition: all 0.3s;
      border-radius: 1px;
    }
    .next-quiz-btn:hover {
      border-color: rgba(255,255,255,0.3);
      color: rgba(255,255,255,0.9);
    }

    /* ===== LOADING ===== */
    .loading-spinner {
      display: inline-block;
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.2);
      border-top-color: #ffd700;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 0.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ===== PARTICLES ===== */
    .particle {
      position: fixed;
      pointer-events: none;
      width: 6px; height: 6px;
      border-radius: 50%;
      animation: particleFall 2s ease-out forwards;
    }
    @keyframes particleFall {
      0% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
      100% { opacity: 0; transform: translate(var(--tx), var(--ty)) rotate(720deg) scale(0); }
    }

    /* ===== SCROLL INDICATOR ===== */
    .scroll-indicator {
      position: absolute;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      color: rgba(255,255,255,0.3);
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      animation: bounce 2s ease-in-out infinite;
    }
    @keyframes bounce {
      0%, 100% { transform: translateX(-50%) translateY(0); }
      50% { transform: translateX(-50%) translateY(-8px); }
    }

    /* ===== RESPONSIVE ===== */
    @media (max-width: 640px) {
      .roulette-wrapper { width: 260px; height: 260px; }
      .site-header { padding: 1rem 1.5rem; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="site-header">
    <div class="site-logo">🎯 NAZO ROULETTE</div>
    <a href="/admin" class="admin-link">ADMIN ↗</a>
  </header>

  <!-- Hero Section -->
  <section class="hero" id="hero-section">
    <div class="hero-bg"></div>
    
    <div class="roulette-section" id="roulette-section">
      <p class="hero-subtitle" id="hero-subtitle">Spin to Start</p>
      <h1 class="hero-title" id="hero-title">なぞなぞ<br>ルーレット</h1>
      <p class="hero-desc" id="hero-desc">ルーレットを回して難易度を決めよう。<br>nazogaku.comのなぞなぞをランダム出題。</p>

      <div class="roulette-wrapper">
        <div class="roulette-pointer"></div>
        <canvas id="roulette-canvas" class="roulette-canvas" width="320" height="320"></canvas>
        <div class="roulette-center"></div>
      </div>

      <div class="result-label" id="result-label">ルーレットを回して難易度を決定しよう</div>

      <button class="spin-btn" id="spin-btn" onclick="spinRoulette()">
        SPIN
      </button>
    </div>

    <!-- Scroll indicator -->
    <div class="scroll-indicator" id="scroll-indicator" style="display:none">
      <span>SCROLL</span>
      <i class="fas fa-chevron-down"></i>
    </div>
  </section>

  <!-- Quiz Section -->
  <section class="quiz-section" id="quiz-section">
    <div class="quiz-card" id="quiz-card">
      <div class="quiz-card-header">
        <span class="difficulty-badge" id="quiz-difficulty-badge">EASY</span>
        <span class="quiz-number" id="quiz-number">QUIZ #001</span>
      </div>
      <img src="" alt="" id="quiz-image" class="quiz-image" style="display:none">
      <div class="quiz-body">
        <div class="quiz-question" id="quiz-question">問題を読み込み中...</div>
        
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

        <button class="next-quiz-btn" id="next-btn" onclick="nextQuiz()">
          <i class="fas fa-redo mr-2"></i>もう一度ルーレットを回す
        </button>
      </div>
    </div>
  </section>

<script>
// ====== ROULETTE CONFIG ======
const DIFFICULTIES = [
  { key: 'very-easy', label: 'やさしい',  color: '#2d6a2d', textColor: '#a3e6a3' },
  { key: 'easy',      label: 'かんたん',  color: '#1a3a6a', textColor: '#7ab8f5' },
  { key: 'normal',    label: 'ふつう',    color: '#5a4a00', textColor: '#ffd060' },
  { key: 'hard',      label: 'むずかしい',color: '#6a1a1a', textColor: '#f57070' },
];

let weights = { 'very-easy': 25, 'easy': 25, 'normal': 25, 'hard': 25 };
let isSpinning = false;
let currentCategory = null;
let quizCount = 0;

// URLパラメータからウェイトを取得
function loadWeightsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  
  // modeパラメータ（固定モード）
  const mode = params.get('mode');
  if (mode && ['very-easy', 'easy', 'normal', 'hard'].includes(mode)) {
    weights = { 'very-easy': 0, 'easy': 0, 'normal': 0, 'hard': 0 };
    weights[mode] = 100;
    return;
  }
  
  // URLの個別ウェイト
  const w = {};
  let total = 0;
  DIFFICULTIES.forEach(d => {
    const v = parseFloat(params.get(d.key) || '0');
    if (v > 0) { w[d.key] = v; total += v; }
  });
  if (total > 0) { weights = w; return; }
  
  // localStorageからも取得
  try {
    const savedMode = localStorage.getItem('roulette_mode');
    if (savedMode && savedMode !== 'random' && ['very-easy', 'easy', 'normal', 'hard'].includes(savedMode)) {
      weights = { 'very-easy': 0, 'easy': 0, 'normal': 0, 'hard': 0 };
      weights[savedMode] = 100;
      return;
    }
    const saved = localStorage.getItem('roulette_weights');
    if (saved) weights = JSON.parse(saved);
  } catch(e) {}
}
loadWeightsFromUrl();

// ====== CANVAS ROULETTE ======
const canvas = document.getElementById('roulette-canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const CX = W / 2, CY = H / 2, R = W / 2 - 4;

function getWeightedSlices() {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return DIFFICULTIES.map(d => ({
    ...d,
    ratio: (weights[d.key] || 0) / total,
    angle: 0,
    endAngle: 0
  })).filter(s => s.ratio > 0);
}

function drawRoulette(rotation = 0) {
  const slices = getWeightedSlices();
  ctx.clearRect(0, 0, W, H);
  
  let currentAngle = rotation - Math.PI / 2;
  slices.forEach(slice => {
    const sliceAngle = slice.ratio * Math.PI * 2;
    
    // Slice fill
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, currentAngle, currentAngle + sliceAngle);
    ctx.closePath();
    
    // Gradient fill
    const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, R);
    grad.addColorStop(0, lightenColor(slice.color, 30));
    grad.addColorStop(1, slice.color);
    ctx.fillStyle = grad;
    ctx.fill();
    
    // Slice border
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Text
    const midAngle = currentAngle + sliceAngle / 2;
    ctx.save();
    ctx.translate(CX + Math.cos(midAngle) * R * 0.62, CY + Math.sin(midAngle) * R * 0.62);
    ctx.rotate(midAngle + Math.PI / 2);
    ctx.fillStyle = slice.textColor;
    ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slice.label, 0, 0);
    
    currentAngle += sliceAngle;
    ctx.restore();
  });

  // Outer ring
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,215,0,0.3)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return \`rgb(\${r},\${g},\${b})\`;
}

drawRoulette();

// ====== SPIN ANIMATION ======
function spinRoulette() {
  if (isSpinning) return;
  isSpinning = true;
  
  const spinBtn = document.getElementById('spin-btn');
  spinBtn.disabled = true;
  spinBtn.innerHTML = '<span class="loading-spinner"></span>SPINNING...';
  
  document.getElementById('result-label').textContent = '';
  document.getElementById('result-label').className = 'result-label';

  // ウィンド決定（ウェイトに基づく）
  const slices = getWeightedSlices();
  const winSlice = weightedRandom(slices);
  
  // 回転角度計算
  const sliceAngle = winSlice.ratio * Math.PI * 2;
  const winAngleStart = getSliceStartAngle(slices, winSlice);
  const targetAngle = -(winAngleStart + sliceAngle / 2);
  
  // ランダムな追加回転 (5〜8周)
  const extraSpins = (5 + Math.random() * 3) * Math.PI * 2;
  const totalRotation = extraSpins + targetAngle;
  
  const duration = 4000 + Math.random() * 1000;
  const startTime = performance.now();
  
  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);
    const currentRotation = totalRotation * eased;
    
    drawRoulette(currentRotation);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      drawRoulette(totalRotation);
      onSpinComplete(winSlice);
    }
  }
  
  requestAnimationFrame(animate);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 4);
}

function getSliceStartAngle(slices, target) {
  let angle = 0;
  for (const s of slices) {
    if (s.key === target.key) return angle;
    angle += s.ratio * Math.PI * 2;
  }
  return 0;
}

function weightedRandom(slices) {
  const total = slices.reduce((a, s) => a + s.ratio, 0);
  let r = Math.random() * total;
  for (const s of slices) {
    r -= s.ratio;
    if (r <= 0) return s;
  }
  return slices[slices.length - 1];
}

function onSpinComplete(slice) {
  isSpinning = false;
  currentCategory = slice.key;
  
  // パーティクル
  createParticles();
  
  // 結果表示
  const labelEl = document.getElementById('result-label');
  labelEl.className = 'result-label active';
  
  const diffNames = {
    'very-easy': '⭐ やさしい (VERY EASY)',
    'easy': '⭐⭐ かんたん (EASY)',
    'normal': '⭐⭐⭐ ふつう (NORMAL)',
    'hard': '⭐⭐⭐⭐ むずかしい (HARD)'
  };
  labelEl.textContent = diffNames[slice.key] + ' に決定！';
  
  // クイズ取得
  fetchQuiz(slice.key);
}

// ====== PARTICLES ======
function createParticles() {
  const colors = ['#ffd700', '#ff8c00', '#ff5050', '#64c864', '#7ab8f5', '#ff69b4'];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = \`
      left: \${40 + Math.random() * 20}%;
      top: 40%;
      background: \${colors[Math.floor(Math.random() * colors.length)]};
      --tx: \${(Math.random() - 0.5) * 400}px;
      --ty: \${Math.random() * 300 + 100}px;
      animation-delay: \${Math.random() * 0.5}s;
    \`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2500);
  }
}

// ====== QUIZ FETCH ======
async function fetchQuiz(category) {
  const spinBtn = document.getElementById('spin-btn');
  spinBtn.innerHTML = '<span class="loading-spinner"></span>問題取得中...';
  
  // ヒント・答えをリセット
  document.getElementById('hint-reveal').classList.remove('open');
  document.getElementById('answer-reveal').classList.remove('open');
  document.getElementById('hint-btn').classList.remove('shown');
  document.getElementById('answer-btn').classList.remove('shown');
  document.getElementById('quiz-card').classList.remove('visible');
  
  try {
    const res = await fetch(\`/api/quiz?category=\${category}\`);
    const data = await res.json();
    
    if (data.error) throw new Error(data.error);
    
    quizCount++;
    displayQuiz(data);
    
    // スクロール
    setTimeout(() => {
      document.getElementById('quiz-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
    
  } catch(e) {
    document.getElementById('quiz-question').textContent = '問題の取得に失敗しました。もう一度お試しください。';
    document.getElementById('quiz-card').classList.add('visible');
    document.getElementById('scroll-indicator').style.display = 'flex';
  } finally {
    spinBtn.disabled = false;
    spinBtn.innerHTML = 'SPIN';
  }
}

function displayQuiz(data) {
  const diffMap = {
    'very-easy': { label: 'VERY EASY', cls: 'diff-very-easy' },
    'easy':      { label: 'EASY',      cls: 'diff-easy' },
    'normal':    { label: 'NORMAL',    cls: 'diff-normal' },
    'hard':      { label: 'HARD',      cls: 'diff-hard' },
  };
  const diff = diffMap[data.category] || diffMap['easy'];
  
  const badge = document.getElementById('quiz-difficulty-badge');
  badge.textContent = diff.label;
  badge.className = 'difficulty-badge ' + diff.cls;
  
  document.getElementById('quiz-number').textContent = 'QUIZ #' + String(quizCount).padStart(3, '0');
  document.getElementById('quiz-question').textContent = data.question;
  document.getElementById('answer-text').textContent = data.answer || '（答えが見つかりませんでした）';
  document.getElementById('hint-text').textContent = data.hint || 'ヒントはありません';
  
  const img = document.getElementById('quiz-image');
  if (data.imageUrl) {
    img.src = data.imageUrl;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  } else {
    img.style.display = 'none';
  }
  
  setTimeout(() => {
    document.getElementById('quiz-card').classList.add('visible');
    document.getElementById('scroll-indicator').style.display = 'flex';
  }, 100);
}

function toggleHint() {
  const reveal = document.getElementById('hint-reveal');
  const btn = document.getElementById('hint-btn');
  reveal.classList.toggle('open');
  if (reveal.classList.contains('open')) {
    btn.classList.add('shown');
    btn.innerHTML = '<i class="fas fa-lightbulb mr-2"></i>ヒントを隠す';
  } else {
    btn.classList.remove('shown');
    btn.innerHTML = '<i class="fas fa-lightbulb mr-2"></i>ヒントを見る';
  }
}

function toggleAnswer() {
  const reveal = document.getElementById('answer-reveal');
  const btn = document.getElementById('answer-btn');
  reveal.classList.toggle('open');
  if (reveal.classList.contains('open')) {
    btn.classList.add('shown');
    btn.innerHTML = '<i class="fas fa-eye-slash mr-2"></i>答えを隠す';
  } else {
    btn.classList.remove('shown');
    btn.innerHTML = '<i class="fas fa-eye mr-2"></i>答えを見る';
  }
}

function nextQuiz() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('quiz-card').classList.remove('visible');
  document.getElementById('scroll-indicator').style.display = 'none';
  document.getElementById('result-label').textContent = 'ルーレットを回して難易度を決定しよう';
  document.getElementById('result-label').className = 'result-label';
}
</script>
</body>
</html>`
}

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

    .admin-header {
      padding: 2rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .back-link {
      color: rgba(255,255,255,0.4);
      text-decoration: none;
      font-size: 0.8rem;
      letter-spacing: 0.1em;
      transition: color 0.2s;
    }
    .back-link:hover { color: #ffd700; }
    .admin-title {
      font-size: 1.2rem;
      font-weight: 900;
      letter-spacing: 0.1em;
      background: linear-gradient(135deg, #f0e68c, #ffd700);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .admin-body { max-width: 800px; margin: 0 auto; padding: 3rem 2rem; }

    .section-title {
      font-size: 0.7rem;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      color: rgba(255,215,0,0.6);
      margin-bottom: 1.5rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid rgba(255,215,0,0.1);
    }

    .mode-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 1rem;
      margin-bottom: 3rem;
    }
    .mode-card {
      padding: 1.5rem 1rem;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 2px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
      background: rgba(255,255,255,0.02);
    }
    .mode-card:hover {
      border-color: rgba(255,215,0,0.3);
      background: rgba(255,215,0,0.04);
    }
    .mode-card.active {
      border-color: rgba(255,215,0,0.6);
      background: rgba(255,215,0,0.08);
    }
    .mode-icon { font-size: 1.8rem; margin-bottom: 0.75rem; display: block; }
    .mode-label { font-size: 0.85rem; font-weight: 700; margin-bottom: 0.25rem; }
    .mode-desc { font-size: 0.7rem; color: rgba(255,255,255,0.4); }

    .weight-controls { margin-bottom: 3rem; }
    .weight-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .weight-label {
      width: 120px;
      flex-shrink: 0;
    }
    .weight-name { font-size: 0.85rem; font-weight: 600; }
    .weight-value {
      font-size: 0.7rem;
      color: rgba(255,255,255,0.4);
    }
    .weight-slider {
      flex: 1;
      -webkit-appearance: none;
      height: 3px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px;
      outline: none;
    }
    .weight-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #ffd700;
      cursor: pointer;
      box-shadow: 0 0 8px rgba(255,215,0,0.5);
    }
    .weight-num {
      width: 50px;
      text-align: right;
      font-size: 0.9rem;
      font-weight: 700;
      color: #ffd700;
    }

    .roulette-preview-wrap {
      display: flex;
      justify-content: center;
      margin: 2rem 0;
    }
    .roulette-preview {
      border-radius: 50%;
      box-shadow: 0 0 40px rgba(255,215,0,0.15);
    }

    .apply-btn {
      display: block;
      width: 100%;
      padding: 1.2rem;
      background: linear-gradient(135deg, #ffd700, #ff8c00);
      color: #0a0a0a;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.15em;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 1rem;
    }
    .apply-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(255,180,0,0.4); }

    .copy-link-box {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 2px;
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-top: 1rem;
    }
    .copy-link-url {
      flex: 1;
      font-size: 0.75rem;
      color: rgba(255,255,255,0.4);
      word-break: break-all;
      font-family: monospace;
    }
    .copy-btn {
      padding: 0.5rem 1rem;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.6);
      font-size: 0.75rem;
      cursor: pointer;
      border-radius: 1px;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .copy-btn:hover { border-color: #ffd700; color: #ffd700; }

    .go-btn {
      display: block;
      text-align: center;
      padding: 1rem;
      margin-top: 1.5rem;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.7);
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      border-radius: 1px;
      transition: all 0.3s;
    }
    .go-btn:hover { border-color: rgba(255,215,0,0.5); color: #ffd700; }

    .status-msg {
      text-align: center;
      font-size: 0.8rem;
      color: #64c864;
      padding: 0.5rem;
      min-height: 1.5rem;
    }
  </style>
</head>
<body>

  <header class="admin-header">
    <a href="/" class="back-link">← BACK</a>
    <div class="admin-title">⚙ ADMIN - ルーレット設定</div>
  </header>

  <div class="admin-body">

    <!-- モード選択 -->
    <div class="section-title">難易度モード選択</div>
    <div class="mode-grid" id="mode-grid">
      <div class="mode-card" data-mode="very-easy" onclick="setMode('very-easy')">
        <span class="mode-icon">⭐</span>
        <div class="mode-label" style="color:#a3e6a3">やさしい</div>
        <div class="mode-desc">VERY EASY固定</div>
      </div>
      <div class="mode-card" data-mode="easy" onclick="setMode('easy')">
        <span class="mode-icon">⭐⭐</span>
        <div class="mode-label" style="color:#7ab8f5">かんたん</div>
        <div class="mode-desc">EASY固定</div>
      </div>
      <div class="mode-card" data-mode="normal" onclick="setMode('normal')">
        <span class="mode-icon">⭐⭐⭐</span>
        <div class="mode-label" style="color:#ffc864">ふつう</div>
        <div class="mode-desc">NORMAL固定</div>
      </div>
      <div class="mode-card" data-mode="hard" onclick="setMode('hard')">
        <span class="mode-icon">⭐⭐⭐⭐</span>
        <div class="mode-label" style="color:#f57070">むずかしい</div>
        <div class="mode-desc">HARD固定</div>
      </div>
      <div class="mode-card active" data-mode="random" onclick="setMode('random')">
        <span class="mode-icon">🎲</span>
        <div class="mode-label" style="color:#ffd700">おまかせ</div>
        <div class="mode-desc">カスタム重み</div>
      </div>
    </div>

    <!-- カスタムウェイト設定 -->
    <div id="weight-section">
      <div class="section-title">ルーレット各難易度の出現確率 (%)</div>
      
      <div class="roulette-preview-wrap">
        <canvas id="admin-roulette" class="roulette-preview" width="220" height="220"></canvas>
      </div>

      <div class="weight-controls" id="weight-controls">
        <div class="weight-row">
          <div class="weight-label">
            <div class="weight-name" style="color:#a3e6a3">やさしい</div>
            <div class="weight-value">VERY EASY</div>
          </div>
          <input type="range" class="weight-slider" id="w-very-easy" min="0" max="100" value="25"
            oninput="updateWeights()" style="accent-color:#a3e6a3">
          <div class="weight-num" id="wn-very-easy">25%</div>
        </div>
        <div class="weight-row">
          <div class="weight-label">
            <div class="weight-name" style="color:#7ab8f5">かんたん</div>
            <div class="weight-value">EASY</div>
          </div>
          <input type="range" class="weight-slider" id="w-easy" min="0" max="100" value="25"
            oninput="updateWeights()" style="accent-color:#7ab8f5">
          <div class="weight-num" id="wn-easy">25%</div>
        </div>
        <div class="weight-row">
          <div class="weight-label">
            <div class="weight-name" style="color:#ffc864">ふつう</div>
            <div class="weight-value">NORMAL</div>
          </div>
          <input type="range" class="weight-slider" id="w-normal" min="0" max="100" value="25"
            oninput="updateWeights()" style="accent-color:#ffc864">
          <div class="weight-num" id="wn-normal">25%</div>
        </div>
        <div class="weight-row">
          <div class="weight-label">
            <div class="weight-name" style="color:#f57070">むずかしい</div>
            <div class="weight-value">HARD</div>
          </div>
          <input type="range" class="weight-slider" id="w-hard" min="0" max="100" value="25"
            oninput="updateWeights()" style="accent-color:#f57070">
          <div class="weight-num" id="wn-hard">25%</div>
        </div>
      </div>
    </div>

    <!-- 適用ボタン -->
    <button class="apply-btn" onclick="applySettings()">
      <i class="fas fa-check mr-2"></i>設定を保存して適用
    </button>
    <div class="status-msg" id="status-msg"></div>

    <!-- リンクコピー -->
    <div class="copy-link-box">
      <div class="copy-link-url" id="share-url">設定を保存するとURLが生成されます</div>
      <button class="copy-btn" onclick="copyLink()">
        <i class="fas fa-copy mr-1"></i>コピー
      </button>
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
let weights = { 'very-easy': 25, 'easy': 25, 'normal': 25, 'hard': 25 };

// localStorageから読み込み
function loadSettings() {
  try {
    const saved = localStorage.getItem('roulette_weights');
    if (saved) {
      weights = JSON.parse(saved);
      DIFFICULTIES.forEach(d => {
        const el = document.getElementById('w-' + d.key);
        if (el && weights[d.key] !== undefined) el.value = weights[d.key];
      });
    }
    const savedMode = localStorage.getItem('roulette_mode');
    if (savedMode) setMode(savedMode, false);
  } catch(e) {}
  updateWeights();
}

function setMode(mode, save = true) {
  currentMode = mode;
  document.querySelectorAll('.mode-card').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  
  const weightSection = document.getElementById('weight-section');
  
  if (mode === 'random') {
    weightSection.style.display = 'block';
    DIFFICULTIES.forEach(d => {
      document.getElementById('w-' + d.key).disabled = false;
    });
  } else {
    weightSection.style.display = 'none';
    // 固定モード: 選択難易度だけ100%
    DIFFICULTIES.forEach(d => {
      weights[d.key] = d.key === mode ? 100 : 0;
      const el = document.getElementById('w-' + d.key);
      if (el) el.value = weights[d.key];
    });
    updateWeights();
  }
  
  if (save) updateShareUrl();
}

function updateWeights() {
  DIFFICULTIES.forEach(d => {
    const el = document.getElementById('w-' + d.key);
    if (el) {
      weights[d.key] = parseInt(el.value) || 0;
      document.getElementById('wn-' + d.key).textContent = weights[d.key] + '%';
    }
  });
  drawAdminRoulette();
  updateShareUrl();
}

// Admin roulette preview
const adminCanvas = document.getElementById('admin-roulette');
const actx = adminCanvas.getContext('2d');
const AW = adminCanvas.width, AH = adminCanvas.height;
const ACX = AW/2, ACY = AH/2, AR = AW/2 - 4;

function drawAdminRoulette() {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) {
    actx.clearRect(0, 0, AW, AH);
    actx.beginPath();
    actx.arc(ACX, ACY, AR, 0, Math.PI * 2);
    actx.fillStyle = 'rgba(255,255,255,0.1)';
    actx.fill();
    return;
  }

  actx.clearRect(0, 0, AW, AH);
  let currentAngle = -Math.PI / 2;

  DIFFICULTIES.forEach(d => {
    const ratio = (weights[d.key] || 0) / total;
    if (ratio <= 0) return;
    const sliceAngle = ratio * Math.PI * 2;
    
    actx.beginPath();
    actx.moveTo(ACX, ACY);
    actx.arc(ACX, ACY, AR, currentAngle, currentAngle + sliceAngle);
    actx.closePath();
    
    const grad = actx.createRadialGradient(ACX, ACY, 0, ACX, ACY, AR);
    grad.addColorStop(0, lightenColor(d.color, 30));
    grad.addColorStop(1, d.color);
    actx.fillStyle = grad;
    actx.fill();
    
    actx.strokeStyle = 'rgba(255,255,255,0.1)';
    actx.lineWidth = 1;
    actx.stroke();

    if (ratio > 0.05) {
      const midAngle = currentAngle + sliceAngle / 2;
      actx.save();
      actx.translate(ACX + Math.cos(midAngle) * AR * 0.6, ACY + Math.sin(midAngle) * AR * 0.6);
      actx.rotate(midAngle + Math.PI / 2);
      actx.fillStyle = d.textColor;
      actx.font = 'bold 10px "Noto Sans JP", sans-serif';
      actx.textAlign = 'center';
      actx.textBaseline = 'middle';
      actx.fillText(d.label, 0, 0);
      actx.restore();
    }
    
    currentAngle += sliceAngle;
  });

  actx.beginPath();
  actx.arc(ACX, ACY, AR, 0, Math.PI * 2);
  actx.strokeStyle = 'rgba(255,215,0,0.3)';
  actx.lineWidth = 2;
  actx.stroke();
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
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
    DIFFICULTIES.forEach(d => {
      if (weights[d.key] > 0) params.set(d.key, weights[d.key]);
    });
    url = window.location.origin + '/?' + params.toString();
  }
  document.getElementById('share-url').textContent = url;
  document.getElementById('go-display-link').href = url.replace(window.location.origin, '');
}

function applySettings() {
  // localStorageに保存
  localStorage.setItem('roulette_weights', JSON.stringify(weights));
  localStorage.setItem('roulette_mode', currentMode);
  
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

// 初期化
loadSettings();
drawAdminRoulette();
</script>
</body>
</html>`
}

export default app
