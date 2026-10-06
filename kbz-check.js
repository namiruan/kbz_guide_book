#!/usr/bin/env node
/* 김반장 가이드북 조판 점검
 *
 *   node kbz-check.js VOL3_*.html            한 권 점검
 *   node kbz-check.js VOL1_*.html VOL2_*.html  여러 권
 *   node kbz-check.js --기준 VOL1_*.html VOL3_*.html   공통 면 기준 권 지정
 *
 * 템플릿_01_조판지시서.md · 템플릿_02_디자인토큰.md 의 규칙을 실제 렌더링으로 확인합니다.
 * 추정 계산을 쓰지 않습니다(§1-3). 위반이 있으면 종료 코드 1.
 *
 * 필요: playwright (chromium)
 */
'use strict'
const fs = require('fs')
const path = require('path')
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch (e) {
  console.error('playwright 를 찾지 못했습니다.  npm i -D playwright  후 다시 실행하세요.')
  process.exit(2)
}

/* ── 템플릿에서 온 상수 ──────────────────────────────── */

// 토큰 「크기」 — 11pt 까지 허용되는 작은 라벨·배지·칩·아이콘의 클래스
// 본문·표 셀·설명·주석·내비·슬로건·면번호·법령 근거는 12pt 그대로.
const 작은요소_허용 = new Set([
  'k', 'lb', 'tag', 'yn', 'cite', 'src', 'src2', 'src4', 'ic', 'mk', 'no2',
  'ar9', 'ar4', 'arw5', 'st9', 'st7', 's7', 'qr', 'qr2', 'qn', 'qn2',
  'amt3', 'x-dg', 'x-tbd', 'diacap', 'cap8', 'imgslot', 'law', 'k2',
])
const 공통면 = ['pg-cover', 'pg-toc', 'pg-vs', 'pg-concl', 'pg-fine', 'pg-rate', 'pg-2027', 'pg-cal', 'pg-year', 'pg-back']
// 권마다 문구가 달라지는 공통 면 — 마크업 대조에서 제외
const 공통면_권별 = new Set(['pg-cover', 'pg-toc', 'pg-vs', 'pg-concl', 'pg-back'])
const 최소여유mm = 1.0   // 넘침 판정 경계
const 권장여유mm = 2.5   // 이보다 빠듯하면 주의

/* ── 유틸 ────────────────────────────────────────── */

const 결과 = []
const 더하기 = (갈래, 파일, 면, 말) => 결과.push({ 갈래, 파일, 면, 말 })

function 정규화(마크업) {
  // id·내비 링크·면번호처럼 권마다 당연히 다른 것을 지워 내용만 남김
  return 마크업
    .replace(/\s*id="p\d+"/g, '')
    .replace(/<div class="nav">[\s\S]*?<\/div>\s*<\/div>/g, '<div class="nav"/></div>')
    .replace(/href="#p\d+"/g, 'href="#p"')
    .replace(/<div class="pgno">[\s\S]*?<\/div>/g, '<div class="pgno"/>')
    .replace(/\s+/g, ' ')
    .trim()
}

function 면들(html) {
  const 시작 = [...html.matchAll(/<div class="[^"]*\bsheet\b[^"]*"/g)].map(m => m.index)
  const 끝 = html.indexOf('<script')
  시작.push(끝 > 0 ? 끝 : html.length)
  const 결과 = []
  for (let i = 0; i < 시작.length - 1; i++) {
    const 조각 = html.slice(시작[i], 시작[i + 1])
    const id = (조각.match(/id="(p\d+)"/) || [])[1] || `#${i + 1}`
    const cls = (조각.match(/<div class="([^"]*)"/) || [])[1] || ''
    결과.push({ id, cls, 마크업: 조각, 번호: i + 1 })
  }
  return 결과
}

/* ── 정적 검사 (브라우저 없이) ─────────────────────────── */

function 정적검사(파일, html, css, 기준) {
  const 이름 = path.basename(파일).slice(0, 5)

  // 1. 공통 스타일시트 동일성 (§8-1)
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1]
  if (style == null) 더하기('CSS', 이름, '-', '<style> 블록이 없습니다')
  else if (style.trim() !== css.trim())
    더하기('CSS', 이름, '-', 'kbz-guide.css 와 내용이 다릅니다 — 모든 권은 같은 스타일시트를 씁니다')

  const 면 = 면들(html)
  const 총면수 = 면.length

  // 2. id 중복 · 깨진 앵커
  const ids = 면.map(s => s.id)
  const 중복 = [...new Set(ids.filter(x => ids.indexOf(x) !== ids.lastIndexOf(x)))]
  if (중복.length) 더하기('구조', 이름, '-', `면 id 중복: ${중복.join(', ')}`)
  const 앵커 = new Set([...html.matchAll(/href="#(p\d+)"/g)].map(m => m[1]))
  const 깨짐 = [...앵커].filter(a => !ids.includes(a))
  if (깨짐.length) 더하기('구조', 이름, '-', `가리키는 면이 없는 링크: ${깨짐.join(', ')}`)

  // 3. 목차 ↔ 실제 면번호, 상단 바 문구
  const 목차면 = 면.find(s => s.cls.includes('pg-toc'))
  const 목차 = new Map()
  if (목차면) {
    for (const m of 목차면.마크업.matchAll(/<a[^>]*href="#(p\d+)"[\s\S]*?<\/a>/g)) {
      const 조각 = m[0]
      const n = (조각.match(/class="n">([\s\S]*?)</) || [])[1]
      const t = (조각.match(/class="t">([\s\S]*?)</) || [])[1]
      const p = (조각.match(/class="p">([\s\S]*?)</) || [])[1]
      목차.set(m[1], { n: (n || '').trim(), t: (t || '').trim(), p: (p || '').trim() })
      const 실제 = Number(m[1].slice(1))
      if (p && Number(p) !== 실제)
        더하기('목차', 이름, m[1], `목차 면번호 ${p} ≠ 실제 ${실제}`)
    }
  } else 더하기('구조', 이름, '-', '목차 면(pg-toc)이 없습니다')

  // 장별 문구표 — 상단 바 좌측 헤더는 목차와 같은 문구 (§6)
  const 장문구 = [...목차.values()]
  for (const s of 면) {
    if (s.cls.includes('pg-cover') || s.cls.includes('pg-back')) {
      // 표지·뒷표지에는 상단 바도 하단 브랜드 라인도 넣지 않습니다
      if (/<div class="topbar"/.test(s.마크업)) 더하기('고정면', 이름, s.id, '표지·뒷표지에 상단 바가 있습니다')
      if (/<div class="pfoot"/.test(s.마크업)) 더하기('고정면', 이름, s.id, '표지·뒷표지에 하단 브랜드 라인이 있습니다')
      continue
    }
    if (s.cls.includes('pg-toc')) {
      // 목차는 상단에 「목차」만, 내비·로고 없음. 푸터는 면 전체 폭으로 둡니다
      if (/<div class="nav">/.test(s.마크업)) 더하기('고정면', 이름, s.id, '목차 면에는 내비를 넣지 않습니다')
      if (!/<div class="pfoot"/.test(s.마크업)) 더하기('고정면', 이름, s.id, '목차 면에 하단 브랜드 라인이 없습니다')
      continue
    }
    if (!/<div class="topbar"/.test(s.마크업)) 더하기('구조', 이름, s.id, '상단 바가 없습니다')
    if (!/<div class="pfoot"/.test(s.마크업)) 더하기('구조', 이름, s.id, '하단 브랜드 라인이 없습니다')

    const 면번호 = s.마크업.match(/<div class="pgno"><b>(\d+)<\/b> \/ (\d+)<\/div>/)
    if (!면번호) 더하기('구조', 이름, s.id, '면 번호(pgno)가 없습니다')
    else {
      if (Number(면번호[1]) !== s.번호) 더하기('구조', 이름, s.id, `면 번호 ${면번호[1]} ≠ 실제 ${s.번호}`)
      if (Number(면번호[2]) !== 총면수) 더하기('구조', 이름, s.id, `총 면수 ${면번호[2]} ≠ 실제 ${총면수}`)
    }

    const crumb = s.마크업.match(/<div class="crumb">[\s\S]*?<b class="cn">([\s\S]*?)<\/b>\s*<span>([\s\S]*?)<\/span>/)
    if (crumb) {
      const 번호 = crumb[1].trim(), 문구 = crumb[2].trim()
      const 짝 = 장문구.find(v => v.n === 번호)
      if (짝 && 짝.t !== 문구)
        더하기('상단바', 이름, s.id, `목차와 문구가 다릅니다\n        상단 바 「${문구}」\n        목차     「${짝.t}」`)
    }
  }

  // 4. 금지 항목 (토큰 「금지」)
  if (/<img\b/.test(html)) 더하기('금지', 이름, '-', '<img> 사용 — 이미지는 자리만 잡고 PNG는 data URI 로 심습니다')
  const 외부 = [...html.matchAll(/src="(https?:[^"]*)"/g)].map(m => m[1])
  if (외부.length) 더하기('금지', 이름, '-', `외부 이미지 링크 ${외부.length}건: ${외부[0]}`)
  for (const s of 면) {
    if (!s.cls.includes('pg-qa')) continue
    if (/class="(sit|sit2|sit3)"/.test(s.마크업))
      더하기('금지', 이름, s.id, 'Q&A 에 「상황」 칸 — 원고 Q&A 는 질문·답변뿐입니다')
  }
  const 표지 = 면.find(s => s.cls.includes('pg-cover'))
  if (표지 && /class="docver"|v\d+\.\d+/.test(표지.마크업))
    더하기('금지', 이름, 표지.id, '표지에 판 번호 표기 — 발행 정보는 「YYYY.MM 발행」 한 줄입니다')

  // 5. 공통 면이 기준 권과 같은지 (§2 부록은 문구·구성·면 수 그대로)
  if (기준 && 기준.파일 !== 파일) {
    for (const key of 공통면) {
      if (공통면_권별.has(key)) continue
      const 내 = 면.filter(s => s.cls.includes(key))
      const 남 = 기준.면.filter(s => s.cls.includes(key))
      if (남.length === 0) continue
      if (내.length !== 남.length) {
        더하기('공통면', 이름, key, `면 수 ${내.length} ≠ 기준 ${남.length}`)
        continue
      }
      내.forEach((s, i) => {
        if (정규화(s.마크업) !== 정규화(남[i].마크업))
          더하기('공통면', 이름, s.id, `${key} 가 기준 권(${기준.이름})과 다릅니다 — 부록은 문구·구성 그대로 복사합니다`)
      })
    }
  }

  return { 면, 총면수 }
}

/* ── 렌더링 검사 ──────────────────────────────────── */

const 브라우저검사 = () => {
  /* 이 함수는 페이지 안에서 실행됩니다 */
  const 자 = document.createElement('div')
  자.style.cssText = 'width:100mm;position:absolute;visibility:hidden'
  document.body.appendChild(자)
  const pxmm = 자.getBoundingClientRect().width / 100
  자.remove()
  const mm = v => +(v / pxmm).toFixed(2)
  const pt = px => px * 72 / 96

  const 쓰인변수 = new Set()
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch (e) { continue }
    const 훑기 = rs => { for (const r of rs) { if (r.style) { for (const m of (r.cssText.match(/var\((--[a-z0-9-]+)/g) || [])) 쓰인변수.add(m.slice(4)) } if (r.cssRules) 훑기(r.cssRules) } }
    훑기(rules)
  }

  const out = { 면: [], 변수: [], 크기: [], 도해: [] }

  document.querySelectorAll('.sheet').forEach(s => {
    const 표지 = s.classList.contains('pg-cover') || s.classList.contains('pg-back')

    // 여유 — 지면을 조금씩 줄여 넘치기 직전까지
    const 원래 = s.style.height
    let 여유 = 0
    const 넘치나 = v => { s.style.height = (210 - v) + 'mm'; return s.scrollHeight - s.clientHeight > 1 }
    if (넘치나(0)) {
      s.style.height = 원래
      여유 = -mm(s.scrollHeight - s.clientHeight)
    } else {
      let lo = 0, hi = 30
      for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (넘치나(mid)) hi = mid; else lo = mid }
      s.style.height = 원래
      여유 = +lo.toFixed(2)
    }

    const 제목 = s.querySelector('.ptitle, .imp-title')
    const 제목top = 제목 && !표지
      ? +((제목.getBoundingClientRect().top - s.getBoundingClientRect().top)).toFixed(1)
      : null
    out.면.push({ id: s.id, 여유, 제목top, 표지 })

    // 인라인으로 선언한 여백 변수가 실제로 쓰이는지
    // 면은 높이가 고정이고 overflow:hidden 이라 scrollHeight 로는 판정되지 않습니다.
    // 안쪽 요소들의 위치 합을 지문 삼아, 값을 크게 흔들어도 그대로면 효력이 없는 것.
    const 지문 = () => {
      let a = 0
      s.querySelectorAll('*').forEach(e => { const r = e.getBoundingClientRect(); a += r.top * 7 + r.left * 3 + r.height })
      return Math.round(a)
    }
    const 선언 = (s.getAttribute('style') || '').match(/--[a-z0-9-]+(?=\s*:)/g) || []
    선언.forEach(v => {
      if (!쓰인변수.has(v)) { out.변수.push({ id: s.id, v, 왜: '참조부없음' }); return }
      const 전 = 지문()
      const 원값 = s.style.getPropertyValue(v)
      s.style.setProperty(v, '40mm')
      const 후 = 지문()
      s.style.setProperty(v, 원값)
      if (전 === 후) out.변수.push({ id: s.id, v, 왜: '대상없음' })
    })
  })

  // 글자 크기 — 11pt 미만은 예외 없음, 11~12pt 는 작은 라벨·배지·칩·아이콘만
  const 본 = new Set()
  document.querySelectorAll('.sheet *').forEach(e => {
    // SVG 안의 글자는 사용자 단위라 pt 로 읽을 수 없습니다 — 아래 「도해」에서 배율을 곱해 따로 봅니다
    if (e.closest('svg')) return
    let 글 = false
    e.childNodes.forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) 글 = true })
    if (!글) return
    const p = pt(parseFloat(getComputedStyle(e).fontSize))
    if (p >= 11.995) return
    const sh = e.closest('.sheet')
    let cls = (typeof e.className === 'string' ? e.className : e.className.baseVal || '')
    // 클래스 없는 <b>·<span> 은 바로 위 요소의 클래스로 판단합니다 (.bar b, .s7 span 등)
    if (!cls.trim() && e.parentElement) cls = (e.parentElement.className || '') + ''
    const key = (sh ? sh.id : '?') + '|' + cls + '|' + p.toFixed(2)
    if (본.has(key)) return
    본.add(key)
    out.크기.push({ id: sh ? sh.id : '?', cls, pt: +p.toFixed(2), 글자: e.textContent.trim().slice(0, 30) })
  })

  // 도해 — SVG 1단위 = 1mm, 글자 최소 4.25u(12pt), 좌우 가운데
  document.querySelectorAll('.sheet svg[viewBox]').forEach(svg => {
    if (svg.classList.contains('logo-sym') || svg.classList.contains('logo-type')) return
    const sh = svg.closest('.sheet'); if (!sh) return
    const vb = svg.viewBox.baseVal, r = svg.getBoundingClientRect()
    const 렌더mm = r.width / pxmm
    const 배율 = 렌더mm / vb.width
    let 최소 = Infinity, 글자 = ''
    svg.querySelectorAll('text').forEach(t => {
      const v = parseFloat(getComputedStyle(t).fontSize) * 배율 / 25.4 * 72
      if (v < 최소) { 최소 = v; 글자 = t.textContent.trim().slice(0, 20) }
    })
    // 가운데 정렬은 담긴 칸 기준으로 봅니다 (2열 배치에서는 면 기준이 아님)
    const 칸 = svg.parentElement.getBoundingClientRect()
    out.도해.push({
      id: sh.id, vb: vb.width, 렌더mm: +렌더mm.toFixed(1), 배율: +배율.toFixed(3),
      최소pt: 최소 === Infinity ? null : +최소.toFixed(2), 글자,
      좌: +((r.left - 칸.left) / pxmm).toFixed(1), 우: +((칸.right - r.right) / pxmm).toFixed(1),
    })
  })

  return out
}

/* ── 실행 ────────────────────────────────────────── */

async function 실행() {
  const 인자 = process.argv.slice(2)
  let 기준경로 = null
  const 파일들 = []
  for (let i = 0; i < 인자.length; i++) {
    if (인자[i] === '--기준' ||인자[i] === '--base') { 기준경로 = 인자[++i]; continue }
    파일들.push(인자[i])
  }
  if (!파일들.length) {
    console.error('쓰임:  node kbz-check.js VOL3_*.html  [--기준 VOL1_*.html]')
    process.exit(2)
  }

  const 뿌리 = path.dirname(path.resolve(파일들[0]))
  const cssPath = path.join(뿌리, 'kbz-guide.css')
  if (!fs.existsSync(cssPath)) { console.error(`kbz-guide.css 를 찾지 못했습니다: ${cssPath}`); process.exit(2) }
  const css = fs.readFileSync(cssPath, 'utf8')

  if (!기준경로) {
    const 후보 = fs.readdirSync(뿌리).filter(f => /^VOL1.*\.html$/.test(f))
    if (후보.length) 기준경로 = path.join(뿌리, 후보[0])
  }
  let 기준 = null
  if (기준경로 && fs.existsSync(기준경로)) {
    const h = fs.readFileSync(기준경로, 'utf8')
    기준 = { 파일: path.resolve(기준경로), 이름: path.basename(기준경로).slice(0, 5), 면: 면들(h) }
  }

  const b = await chromium.launch()
  for (const f의 of 파일들) {
    const f = path.resolve(f의)
    const 이름 = path.basename(f).slice(0, 5)
    const html = fs.readFileSync(f, 'utf8')
    정적검사(f, html, css, 기준)

    const p = await b.newPage({ viewport: { width: 1600, height: 1200 } })
    await p.goto('file://' + f)
    await p.waitForTimeout(1200)
    const r = await p.evaluate(브라우저검사)
    await p.close()

    const 본문제목top = r.면.filter(s => !s.표지 && s.제목top != null).map(s => s.제목top)
    const 기준top = 본문제목top.length ? 본문제목top[0] : null

    for (const s of r.면) {
      if (s.여유 < 0) 더하기('넘침', 이름, s.id, `${(-s.여유).toFixed(2)}mm 넘칩니다 — 여백을 조이거나 면을 나눕니다`)
      else if (s.여유 < 최소여유mm) 더하기('넘침', 이름, s.id, `여유 ${s.여유}mm — 사실상 경계입니다`)
      else if (s.여유 < 권장여유mm) 더하기('주의', 이름, s.id, `여유 ${s.여유}mm — 폰트가 바뀌면 넘칠 수 있습니다`)
      if (기준top != null && s.제목top != null && Math.abs(s.제목top - 기준top) > 1)
        더하기('제목위치', 이름, s.id, `제목 top ${s.제목top}px ≠ 다른 면 ${기준top}px — 제목은 모든 면에서 같은 위치에 섭니다`)
    }

    for (const v of r.변수) {
      더하기('변수', 이름, v.id, v.왜 === '참조부없음'
        ? `${v.v} 선언 — CSS 어디에도 var(${v.v}) 가 없어 아무 효과가 없습니다`
        : `${v.v} 선언 — 이 면에 적용 대상이 없어 아무 효과가 없습니다`)
    }

    for (const c of r.크기) {
      const 토큰 = c.cls.split(/\s+/).filter(Boolean)
      const 허용 = 토큰.some(t => 작은요소_허용.has(t))
      if (c.pt < 10.995)
        더하기('크기', 이름, c.id, `${c.pt}pt 「${c.글자}」 — 11pt 미만은 예외가 없습니다`)
      else if (!허용)
        더하기('크기', 이름, c.id, `${c.pt}pt 「${c.글자}」(.${토큰.join('.') || '?'}) — 11pt 예외는 작은 라벨·배지·칩·아이콘뿐입니다`)
    }

    for (const d of r.도해) {
      if (d.최소pt != null && d.최소pt < 11.995)
        더하기('도해', 이름, d.id, `글자 ${d.최소pt}pt 「${d.글자}」 — 좁으면 축소하지 말고 다시 그립니다`)
      if (Math.abs(d.배율 - 1) > 0.02)
        더하기('도해', 이름, d.id, `viewBox ${d.vb} 를 ${d.렌더mm}mm 로 ${d.배율}배 — SVG 1단위 = 1mm 로 그립니다`)
      if (Math.abs(d.좌 - d.우) > 2 && d.좌 + d.우 > 10)
        더하기('도해', 이름, d.id, `좌 ${d.좌}mm / 우 ${d.우}mm — 가운데 정렬을 확인하세요`)
    }
  }
  await b.close()

  /* 보고 */
  const 순서 = ['CSS', '구조', '넘침', '크기', '도해', '변수', '상단바', '목차', '공통면', '고정면', '금지', '제목위치', '주의']
  결과.sort((a, b) => 순서.indexOf(a.갈래) - 순서.indexOf(b.갈래))
  if (!결과.length) {
    console.log('\n  어긋난 곳이 없습니다.\n')
    return 0
  }
  console.log('')
  let 현재 = null
  for (const r of 결과) {
    if (r.갈래 !== 현재) { 현재 = r.갈래; console.log(`  [${현재}]`) }
    console.log(`    ${r.파일} ${String(r.면).padEnd(5)} ${r.말}`)
  }
  const 위반 = 결과.filter(r => r.갈래 !== '주의').length
  const 주의 = 결과.length - 위반
  console.log(`\n  위반 ${위반}건${주의 ? ` · 주의 ${주의}건` : ''}\n`)
  return 위반 ? 1 : 0
}

실행().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(2) })
