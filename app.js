/**
 * 整理券ソフト  app.js
 *
 * 目次
 *   1. 設定値
 *   2. ユーティリティ
 *   3. Store      保存データ（localStorage）
 *   4. Formula    待ち時間の計算式（安全な式パーサ）
 *   5. Queue      整理券の発行・呼出・削除
 *   6. Log        操作ログ（CSV出力・取り込み）
 *   7. Lock       取り込み用ロック（照合値のみ保持）
 *   8. Settings   dinoモード・計算式
 *   9. Background 背景画像・暗さ・文字色（自動）
 *  10. View       画面の描画
 *  11. Dialog     確認ダイアログ・キー入力
 *  12. Debug      debug画面
 *  13. Events     イベント登録
 *  14. 起動
 */
(function () {
  'use strict';

  /* ========== 1. 設定値 ========== */
  const CONFIG = {
    storageKey: 'seiriken.v1',
    backgroundKey: 'seiriken.bg',
    settingsKey: 'seiriken.settings',
    // 待ち時間の計算式の初期値（単位は秒）。x=一組、y=人数。前に待つ各組ごとに計算して合計する
    defaultFormulas: { default: 'x*120', dino: '30+20*y' },
    groupWindowMs: 1500,    // この時間内の連続タップは同じ組
    logLimit: 5000,         // ログの最大保存件数
    defaultDim: 55,         // 背景の暗さ（%）
    imageMaxPx: 1920        // 背景画像の最大サイズ（長辺）
  };

  /* ========== 2. ユーティリティ ========== */
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  /** 組の人数（＝枚数） */
  const groupSize = (g) => g.to - g.from + 1;
  /** 組の表示用番号。例: 005 / 005〜007 */
  const ticketText = (g) => (g.from === g.to ? pad3(g.from) : pad3(g.from) + '〜' + pad3(g.to));
  const clockText = (t) => new Date(t).toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
  /** 例: 2026-10-30 14:05:09 */
  const dateText = (t) => {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };
  /** 待ち時間の表示。1分未満は秒、それ以上は分（切り上げ） */
  const formatWait = (sec) => (sec < 60 ? '約 ' + Math.ceil(sec) + ' 秒' : '約 ' + Math.ceil(sec / 60) + ' 分');
  const blank = (v) => (v === undefined || v === null ? '' : v);

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function download(filename, mime, text) {
    const blob = new Blob(['\ufeff' + text], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ========== 3. Store ========== */
  const Store = {
    data: { nextNo: 1, groups: [], log: [] },

    load() {
      const saved = readJson(CONFIG.storageKey);
      if (saved && Array.isArray(saved.groups) && Number.isInteger(saved.nextNo)) {
        saved.log = Array.isArray(saved.log) ? saved.log : [];
        saved.log.forEach((e) => { if (e.text !== undefined && e.memo === undefined) { e.memo = e.text; delete e.text; } });
        this.data = saved;
      }
    },
    save() { writeJson(CONFIG.storageKey, this.data); }
  };

  /* ========== 4. Formula ========== */
  const Formula = (function () {
    const FUNCS = { min: Math.min, max: Math.max, ceil: Math.ceil, floor: Math.floor, round: Math.round, abs: Math.abs };
    const VARS = { x: 'groups', y: 'people' };

    function tokenize(src) {
      const text = String(src).normalize('NFKC').replace(/×/g, '*').replace(/÷/g, '/');
      const tokens = [];
      let i = 0;
      while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) { i++; continue; }
        const rest = text.slice(i);
        let m = /^(\d+\.?\d*|\.\d+)/.exec(rest);
        if (m) { tokens.push({ t: 'num', v: parseFloat(m[1]) }); i += m[1].length; continue; }
        m = /^[A-Za-z_\u3040-\u30ff\u3400-\u9fff]+/.exec(rest);
        if (m) { tokens.push({ t: 'id', v: m[0].toLowerCase() }); i += m[0].length; continue; }
        if ('+-*/%(),'.indexOf(ch) >= 0) { tokens.push({ t: ch }); i++; continue; }
        throw new Error('使えない文字: ' + ch);
      }
      return tokens;
    }

    function parse(tokens) {
      let pos = 0;
      const peek = () => tokens[pos];
      const next = () => tokens[pos++];
      const expect = (t, msg) => { const tk = next(); if (!tk || tk.t !== t) throw new Error(msg); };

      function expr() {
        let node = term();
        while (peek() && (peek().t === '+' || peek().t === '-')) {
          const op = next().t;
          node = { k: 'bin', op: op, l: node, r: term() };
        }
        return node;
      }
      function term() {
        let node = unary();
        for (;;) {
          const p = peek();
          if (!p) break;
          if (p.t === '*' || p.t === '/' || p.t === '%') {
            const op = next().t;
            node = { k: 'bin', op: op, l: node, r: unary() };
          } else if (p.t === 'id' || p.t === '(') {
            node = { k: 'bin', op: '*', l: node, r: unary() };
          } else break;
        }
        return node;
      }
      function unary() {
        const p = peek();
        if (p && p.t === '-') { next(); return { k: 'neg', x: unary() }; }
        if (p && p.t === '+') { next(); return unary(); }
        return primary();
      }
      function primary() {
        const tk = next();
        if (!tk) throw new Error('式が途中で終わっています');
        if (tk.t === 'num') return { k: 'num', n: tk.v };
        if (tk.t === '(') { const e = expr(); expect(')', '括弧が閉じていません'); return e; }
        if (tk.t === 'id') {
          if (FUNCS[tk.v] && peek() && peek().t === '(') {
            next();
            const args = [];
            if (peek() && peek().t === ')') next();
            else {
              for (;;) {
                args.push(expr());
                const sep = next();
                if (sep && sep.t === ',') continue;
                if (sep && sep.t === ')') break;
                throw new Error('括弧が閉じていません');
              }
            }
            return { k: 'fn', name: tk.v, args: args };
          }
          if (VARS[tk.v]) return { k: 'var', name: VARS[tk.v] };
          throw new Error('不明な名前: ' + tk.v);
        }
        throw new Error('式の形が正しくありません');
      }

      const ast = expr();
      if (pos < tokens.length) throw new Error('余分な部分があります');
      return ast;
    }

    function run(n, vars) {
      switch (n.k) {
        case 'num': return n.n;
        case 'var': return vars[n.name];
        case 'neg': return -run(n.x, vars);
        case 'fn': return FUNCS[n.name].apply(null, n.args.map((a) => run(a, vars)));
        default: {
          const a = run(n.l, vars), b = run(n.r, vars);
          return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a % b;
        }
      }
    }

    function compile(text) {
      if (!String(text).trim()) throw new Error('式が空です');
      const ast = parse(tokenize(text));
      return (vars) => {
        const v = run(ast, vars);
        if (!isFinite(v)) throw new Error('計算結果が数値になりません');
        return v;
      };
    }
    function check(text) {
      try {
        const f = compile(text);
        const samples = [1, 2, 3, 5].map((n) => [n, f({ groups: 1, people: n })]);
        return { ok: true, samples: samples };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { compile: compile, check: check };
  })();

  /* ========== 5. Queue ========== */
  const Queue = {
    lastTapAt: 0,
    openGroupId: null,
    transitionTimer: null,

    issue() {
      const now = Date.now();
      const groups = Store.data.groups;
      const last = groups[groups.length - 1];
      const no = Store.data.nextNo;

      const isContinuing = last && last.id === this.openGroupId && last.status === 'waiting' &&
                           now - this.lastTapAt < CONFIG.groupWindowMs;
      let group;
      if (isContinuing) {
        last.to = no;
        group = last;
      } else {
        group = { id: now, from: no, to: no, time: now, status: 'waiting' };
        groups.push(group);
        this.openGroupId = group.id;
      }

      Store.data.nextNo = no + 1;
      this.lastTapAt = now;
      Log.add('発行', group, no);
      Store.save();
      View.render();
      View.pulse();

      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.transitionTimer = setTimeout(() => {
        View.render();
      }, CONFIG.groupWindowMs + 50);
    },

    remove(id) {
      const groups = Store.data.groups;
      const index = groups.findIndex((g) => String(g.id) === String(id));
      if (index < 0) return;

      const group = groups.splice(index, 1)[0];
      Log.add('削除', group);
      if (index === groups.length && group.to === Store.data.nextNo - 1) Store.data.nextNo = group.from;
      if (this.openGroupId === id) this.openGroupId = null;
      Store.save();
      View.render();
    },

    callNext() {
      const group = Store.data.groups.find((g) => g.status === 'waiting');
      if (!group) return;
      group.status = 'called';
      Log.add('呼出', group);
      Store.save();
      View.render();
    },

    waitingCount() {
      return Store.data.groups.filter((g) => g.status === 'waiting').length;
    },
    aheadOf(index) {
      return Store.data.groups.slice(0, index).filter((g) => g.status === 'waiting').length;
    },
    waitSeconds(index) {
      let total = 0;
      Store.data.groups.slice(0, index).forEach((g) => {
        if (g.status === 'waiting') total += Math.max(0, Settings.secondsFor(g));
      });
      return total;
    }
  };

  /* ========== 6. Log ========== */
  const Log = {
    HEADER: ['日時', '種別', '番号', '開始', '終了', '人数', '組ID', 'メモ'],
    TYPES: ['発行', '呼出', '削除'],

    add(type, group, no) {
      const log = Store.data.log;
      log.push({ t: Date.now(), type: type, no: blank(no), from: group.from, to: group.to, size: groupSize(group), id: group.id });
      if (log.length > CONFIG.logLimit) log.splice(0, log.length - CONFIG.logLimit);
    },

    toCsv() {
      const esc = (v) => {
        const s = String(blank(v));
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = Store.data.log.map((e) =>
        [dateText(e.t), e.type, e.no, e.from, e.to, e.size, e.id, e.memo].map(esc).join(','));
      return [this.HEADER.join(',')].concat(rows).join('\r\n') + '\r\n';
    },
    exportCsv() {
      const d = new Date();
      const name = 'seiriken_log_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
                   '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.csv';
      download(name, 'text/csv', this.toCsv());
    },

    parseCsv(text) {
      const rows = [];
      let row = [], field = '', quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
          else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      return rows;
    },

    fromCsv(text) {
      const rows = this.parseCsv(text.replace(/^\ufeff/, '')).filter((r) => r.some((c) => c !== ''));
      if (!rows.length || this.HEADER.slice(0, 7).some((h, i) => rows[0][i] !== h)) throw new Error('CSVの形式が違います');

      return rows.slice(1).map((r, i) => {
        const row = i + 2;
        const cell = (k) => (r[k] === undefined ? '' : r[k]);
        const num = (k, name) => {
          if (cell(k) === '') return '';
          const n = Number(cell(k));
          if (!isFinite(n)) throw new Error(row + '行目: ' + name + 'が数値ではありません');
          return n;
        };
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(cell(0));
        if (!m) throw new Error(row + '行目: 日時の形式が違います');
        if (this.TYPES.indexOf(cell(1)) < 0) throw new Error(row + '行目: 種別が違います');

        const e = {
          t: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(),
          type: cell(1), no: num(2, '番号'), from: num(3, '開始'), to: num(4, '終了'), size: num(5, '人数'), id: num(6, '組ID')
        };
        if (cell(7) !== '') e.memo = cell(7);
        if (e.id !== '' && (e.from === '' || e.to === '' || (e.type === '発行' && e.no === ''))) {
          throw new Error(row + '行目: 必要な数値が足りません');
        }
        return e;
      });
    },

    rebuild(log) {
      let nextNo = 1;
      const groups = [];
      log.forEach((e) => {
        if (e.id === '' || e.id === undefined) return;
        const index = groups.findIndex((g) => g.id === e.id);
        if (e.type === '発行') {
          if (index >= 0) groups[index].to = e.to;
          else groups.push({ id: e.id, from: e.from, to: e.to, time: e.id, status: 'waiting' });
          nextNo = e.no + 1;
        } else if (e.type === '呼出') {
          if (index >= 0) groups[index].status = 'called';
        } else if (e.type === '削除' && index >= 0) {
          const g = groups.splice(index, 1)[0];
          if (index === groups.length && g.to === nextNo - 1) nextNo = g.from;
        }
      });
      return { nextNo: nextNo, groups: groups };
    }
  };

  /* ========== 7. Lock ========== */
  const Lock = (function () {
    const salt = '591c836eefea3ecf';
    const rounds = 4000;
    const expected = '132c6b2c0cc610c8c1f743cf8cd81cb8230ede64b75b3f80813e0310eef1060f';

    const K = [], H0 = [];
    for (let c = 2, n = 0; n < 64; c++) {
      let prime = true;
      for (let d = 2; d * d <= c; d++) if (c % d === 0) { prime = false; break; }
      if (!prime) continue;
      if (n < 8) H0[n] = (Math.pow(c, 0.5) * 4294967296) | 0;
      K[n++] = (Math.pow(c, 1 / 3) * 4294967296) | 0;
    }
    function sha256(msg) {
      const len = msg.length;
      const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
      padded.set(msg);
      padded[len] = 0x80;
      const dv = new DataView(padded.buffer);
      dv.setUint32(padded.length - 8, Math.floor(len * 8 / 4294967296));
      dv.setUint32(padded.length - 4, (len * 8) >>> 0);
      const w = new Array(64);
      let h = H0.slice();
      for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
          const a = w[i - 15], b = w[i - 2];
          const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
          const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
          const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
          const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
          const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
          const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map((v) => v | 0);
      }
      const out = new Uint8Array(32);
      const odv = new DataView(out.buffer);
      h.forEach((v, i) => odv.setUint32(i * 4, v >>> 0));
      return out;
    }
    const toHex = (bytes) => Array.prototype.map.call(bytes, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('');

    return {
      verify(input) {
        const enc = new TextEncoder();
        const saltBytes = enc.encode(salt);
        let h = sha256(enc.encode(salt + ':' + String(input).normalize('NFKC').trim()));
        for (let i = 0; i < rounds; i++) {
          const buf = new Uint8Array(h.length + saltBytes.length);
          buf.set(h);
          buf.set(saltBytes, h.length);
          h = sha256(buf);
        }
        return toHex(h) === expected;
      }
    };
  })();

  /* ========== 8. Settings ========== */
  const Settings = {
    state: { theme: 'default', formulas: { default: CONFIG.defaultFormulas.default, dino: CONFIG.defaultFormulas.dino } },

    mode() { return this.state.theme === 'dino' ? 'dino' : 'default'; },
    formula() { return this.state.formulas[this.mode()]; },

    load() {
      const saved = readJson(CONFIG.settingsKey);
      if (!saved) return;
      const f = saved.formulas || {};
      const conv = (t) => (typeof t === 'string' ? t.replace(/(^|[^0-9.])1組/g, '$1x').replace(/組/g, 'x').replace(/人数/g, 'y') : t);
      const valid = (t) => typeof t === 'string' && Formula.check(t).ok;
      const minutes = Number(saved.minutes);
      const legacy = Number.isInteger(minutes) && minutes > 0 ? 'x*' + minutes * 60 : null;
      this.state = {
        theme: saved.theme === 'dino' ? 'dino' : 'default',
        formulas: {
          default: valid(conv(f.default)) ? conv(f.default) : (legacy || CONFIG.defaultFormulas.default),
          dino: valid(conv(f.dino)) ? conv(f.dino) : CONFIG.defaultFormulas.dino
        }
      };
    },
    save() { writeJson(CONFIG.settingsKey, this.state); },

    apply() {
      const dino = this.state.theme === 'dino';
      if (dino) document.documentElement.setAttribute('data-theme', 'dino');
      else document.documentElement.removeAttribute('data-theme');
      $('dinoBtn').setAttribute('aria-pressed', String(dino));
      $('dinoBtn').textContent = 'dino ' + (dino ? 'ON' : 'OFF');
    },
    toggleDino() {
      this.state.theme = this.state.theme === 'dino' ? 'default' : 'dino';
      this.save();
      this.apply();
      View.render();
    },

    setFormula(mode, text) {
      if (!Formula.check(text).ok) return false;
      this.state.formulas[mode] = text;
      this.save();
      View.render();
      return true;
    },
    resetFormulas() {
      this.state.formulas = { default: CONFIG.defaultFormulas.default, dino: CONFIG.defaultFormulas.dino };
      this.save();
      View.render();
    },

    secondsFor(group) {
      const vars = { groups: 1, people: groupSize(group) };
      try {
        return Formula.compile(this.formula())(vars);
      } catch (e) {
        return Formula.compile(CONFIG.defaultFormulas[this.mode()])(vars);
      }
    }
  };

  /* ========== 9. Background ========== */
  const Background = {
    state: { img: '', dim: CONFIG.defaultDim, acc: null },

    load() {
      const saved = readJson(CONFIG.backgroundKey);
      if (!saved) return;
      this.state = {
        img: typeof saved.img === 'string' ? saved.img : '',
        dim: Number.isFinite(saved.dim) ? saved.dim : CONFIG.defaultDim,
        acc: saved.acc && Array.isArray(saved.acc.m) ? { m: saved.acc.m } : null
      };
    },
    save() {
      const ok = writeJson(CONFIG.backgroundKey, this.state);
      $('dbgMsg').textContent = ok ? '' : '背景画像が大きく保存できませんでした（再読み込みで元に戻ります）';
    },

    apply() {
      const s = this.state;
      const url = s.img ? 'url("' + s.img + '")' : '';
      $('bg').style.backgroundImage = url;
      $('veil').style.opacity = s.img ? s.dim / 100 : 0;
      $('dim').value = s.dim;
      $('dimVal').textContent = s.dim;
      $('preview').style.backgroundImage = url;
      $('preview').textContent = s.img ? '' : '画像なし';

      const root = document.documentElement.style;
      if (s.img && s.acc) root.setProperty('--accent-rgb', s.acc.m.join(','));
      else root.removeProperty('--accent-rgb');
    },

    setImage(file) {
      this.fitImage(file, (dataUrl) => {
        if (!dataUrl) { $('dbgMsg').textContent = '画像を読み込めませんでした'; return; }
        this.extractAccent(dataUrl, (acc) => {
          this.state.img = dataUrl;
          this.state.acc = acc;
          this.apply();
          this.save();
        });
      });
    },
    clear() {
      this.state.img = '';
      this.state.acc = null;
      this.apply();
      this.save();
    },
    setDim(value) {
      this.state.dim = value;
      this.apply();
      this.save();
    },

    fitImage(file, done) {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, CONFIG.imageMaxPx / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => done(null);
        img.src = reader.result;
      };
      reader.onerror = () => done(null);
      reader.readAsDataURL(file);
    },

    extractAccent(src, done) {
      const img = new Image();
      img.onload = () => {
        const N = 48;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = N;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, N, N);
        const px = ctx.getImageData(0, 0, N, N).data;

        let vx = 0, vy = 0, weight = 0, count = 0, R = 0, G = 0, B = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
          const diff = Math.max(r, g, b) - Math.min(r, g, b);
          if (diff > 0.02) {
            const rad = hueOf(r, g, b) * Math.PI / 180;
            vx += Math.cos(rad) * diff; vy += Math.sin(rad) * diff;
          }
          weight += diff; R += r; G += g; B += b; count++;
        }

        let rgb;
        if (weight / count < 0.06) {
          rgb = hslToRgb(hueOf(R / count, G / count, B / count), 0.08, 0.86);
        } else {
          let hue = Math.atan2(vy, vx) * 180 / Math.PI;
          if (hue < 0) hue += 360;
          rgb = hslToRgb(hue, 0.78, 0.68);
        }
        done({ m: rgb });
      };
      img.onerror = () => done(null);
      img.src = src;
    }
  };

  function hueOf(r, g, b) {
    const max = Math.max(r, g, b), diff = max - Math.min(r, g, b);
    if (!diff) return 0;
    let h = max === r ? ((g - b) / diff) % 6 : max === g ? (b - r) / diff + 2 : (r - g) / diff + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
  function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }

  /* ========== 10. View ========== */
  const View = {
    render() {
      this.renderCount();
      this.renderTicket();
      this.renderList();
      Debug.refreshState();
    },

    renderCount() {
      $('queueNum').textContent = Queue.waitingCount();
    },

    /** 左側：1.5秒過ぎたらまだ呼び出していない組を表示。待ち時間は常に最後尾の組の時間を反映 */
    renderTicket() {
      const groups = Store.data.groups;
      const num = $('num'), party = $('party'), wait = $('wait');

      if (!groups.length) {
        num.textContent = '---';
        num.className = 'number is-empty';
        party.textContent = '';
        wait.innerHTML = '';
        return;
      }

      const now = Date.now();
      const isWithinWindow = (now - Queue.lastTapAt) < CONFIG.groupWindowMs;

      let group, index;
      if (isWithinWindow) {
        index = groups.length - 1;
        group = groups[index];
      } else {
        const waitingGroup = groups.find((g) => g.status === 'waiting');
        if (waitingGroup) {
          group = waitingGroup;
          index = groups.indexOf(group);
        } else {
          index = groups.length - 1;
          group = groups[index];
        }
      }

      num.textContent = ticketText(group);
      num.className = 'number' + (group.from === group.to ? '' : ' is-range');
      party.textContent = groupSize(group) > 1 ? groupSize(group) + '名様（' + groupSize(group) + '枚）' : '';

      if (group.status === 'called') {
        wait.innerHTML = '<p class="wait__time is-ok">お呼び出し済み</p>';
        return;
      }

      // 待ち時間は常に「最後の組（最後尾）」のインデックスを基準に計算・表示する
      const lastIndex = groups.length - 1;
      const ahead = Queue.aheadOf(lastIndex);
      
      wait.innerHTML = ahead === 0
        ? '<p class="wait__time">まもなくご案内</p>'
        : '<p class="wait__label">お待ち時間の目安 前に ' + ahead + ' 組</p>' +
          '<p class="wait__time">' + formatWait(Queue.waitSeconds(lastIndex)) + '</p>';
    },

    /** 右側：発行リスト（新しい順。通し番号は発行順） */
    renderList() {
      const list = $('list');
      const groups = Store.data.groups;
      list.innerHTML = '';

      if (!groups.length) {
        list.innerHTML = '<li class="list-empty">発行済みの整理券はありません</li>';
        return;
      }
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        const called = g.status === 'called';
        const li = document.createElement('li');
        li.className = 'item' + (called ? ' is-called' : '');
        li.innerHTML =
          '<span class="item__serial">' + (i + 1) + '</span>' +
          '<span class="item__no">' + ticketText(g) + '</span>' +
          '<span class="item__meta"><b>' + groupSize(g) + '名</b> ' + clockText(g.time) + (called ? ' 呼出済' : '') + '</span>' +
          '<button class="btn btn--danger btn--small" type="button" data-id="' + g.id + '">削除</button>';
        list.appendChild(li);
      }
    },

    /** 発行の手ごたえ：番号の動きと、まとめ時間バー */
    pulse() {
      const num = $('num');
      num.classList.remove('is-pop');
      void num.offsetWidth;
      num.classList.add('is-pop');

      const bar = $('win');
      bar.style.animationDuration = CONFIG.groupWindowMs + 'ms';
      bar.classList.remove('is-running');
      void bar.offsetWidth;
      bar.classList.add('is-running');
    },

    /** 右上の日付と時刻 */
    tickClock() {
      const now = new Date();
      $('time').textContent = now.toLocaleTimeString('ja-JP', { hour12: false });
      $('date').textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    }
  };

  /* ========== 11. Dialog ========== */
  const Dialog = {
    onConfirm: null,
    onUnlock: null,

    open(id) { $(id).classList.add('is-open'); },
    close(id) { $(id).classList.remove('is-open'); },

    confirm(html, okText, onConfirm) {
      $('confirmText').innerHTML = html;
      $('confirmOk').textContent = okText;
      this.onConfirm = onConfirm;
      this.open('confirmOv');
    },
    accept() {
      const action = this.onConfirm;
      this.cancel();
      if (action) action();
    },
    cancel() {
      this.onConfirm = null;
      this.close('confirmOv');
    },

    askKey(onUnlock) {
      $('keyInput').value = '';
      $('keyMsg').textContent = '';
      this.onUnlock = onUnlock;
      this.open('keyOv');
      $('keyInput').focus();
    },
    submitKey() {
      if (!Lock.verify($('keyInput').value)) {
        $('keyMsg').textContent = 'キーが違います';
        $('keyInput').value = '';
        return;
      }
      const action = this.onUnlock;
      this.cancelKey();
      if (action) action();
    },
    cancelKey() {
      this.onUnlock = null;
      $('keyInput').value = '';
      this.close('keyOv');
    }
  };

  /* ========== 12. Debug ========== */
  const Debug = {
    refresh() {
      [['default', 'fDefault', 'sDefault'], ['dino', 'fDino', 'sDino']].forEach((m) => {
        const input = $(m[1]);
        if (document.activeElement !== input) input.value = Settings.state.formulas[m[0]];
        this.showStatus(m[2], input.value, Settings.mode() === m[0]);
      });
      this.refreshState();
    },

    showStatus(statusId, text, active) {
      const r = Formula.check(text);
      const el = $(statusId);
      el.className = 'dbg-status' + (r.ok ? '' : ' is-ng');
      el.textContent = (active ? '◀  ' : '') + (r.ok
        ? 'OK  ' + r.samples.map((s) => s[0] + '名=' + Math.round(s[1] * 10) / 10 + '秒').join('  ')
        : 'NG  ' + r.error);
    },

    onFormulaInput(mode, statusId, value) {
      Settings.setFormula(mode, value);
      this.showStatus(statusId, value, Settings.mode() === mode);
    },

    refreshState() {
      const d = Store.data;
      const waiting = Queue.waitingCount();
      const people = d.groups.reduce((sum, g) => sum + groupSize(g), 0);
      const size = (key) => { try { return (localStorage.getItem(key) || '').length; } catch (e) { return '?'; } };
      $('dbgState').textContent = [
        'mode        : ' + Settings.mode(),
        'formula     : ' + Settings.formula(),
        'nextNo      : ' + d.nextNo,
        'groups      : ' + d.groups.length + ' (waiting ' + waiting + ' / called ' + (d.groups.length - waiting) + ')',
        'people      : ' + people,
        'log rows    : ' + d.log.length,
        'storage(chr): v1=' + size(CONFIG.storageKey) + ' bg=' + size(CONFIG.backgroundKey) + ' settings=' + size(CONFIG.settingsKey),
        'groupWindow : ' + CONFIG.groupWindowMs + 'ms',
        'last groups : ' + JSON.stringify(d.groups.slice(-5))
      ].join('\n');
    },

    startImport() {
      $('dbgMsg').textContent = '';
      Dialog.askKey(() => $('importFile').click());
    },
    onImportFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const log = Log.fromCsv(String(reader.result));
          const rebuilt = Log.rebuild(log);
          Dialog.confirm(
            'CSV <strong>' + log.length + '</strong> 行を取り込み、<br>現在のデータを置き換えます。',
            '取り込む',
            () => {
              Store.data = { nextNo: rebuilt.nextNo, groups: rebuilt.groups, log: log };
              Queue.openGroupId = null;
              Queue.lastTapAt = 0;
              Store.save();
              View.render();
              $('dbgMsg').textContent = '';
            }
          );
        } catch (e) {
          $('dbgMsg').textContent = 'import失敗: ' + e.message;
        }
      };
      reader.onerror = () => { $('dbgMsg').textContent = 'import失敗: ファイルを読めません'; };
      reader.readAsText(file);
    }
  };

  /* ========== 13. Events ========== */
  function onScreenTouch(e) {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('.side, .settings-btn, .overlay, button, label, input, a')) return;
    Queue.issue();
  }

  function onListClick(e) {
    const button = e.target.closest('button[data-id]');
    if (!button) return;
    const group = Store.data.groups.find((g) => String(g.id) === String(button.dataset.id));
    if (!group) return;
    Dialog.confirm(
      '整理券 <strong>' + ticketText(group) + '</strong>（' + groupSize(group) + '名）を削除します。<br>よろしいですか？',
      '削除する',
      () => Queue.remove(group.id)
    );
  }

  function bindEvents() {
    document.addEventListener('pointerdown', onScreenTouch);
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    $('list').addEventListener('click', onListClick);
    $('callNext').addEventListener('click', () => Queue.callNext());

    $('confirmOk').addEventListener('click', () => Dialog.accept());
    $('confirmNo').addEventListener('click', () => Dialog.cancel());
    $('confirmOv').addEventListener('click', (e) => { if (e.target === e.currentTarget) Dialog.cancel(); });

    $('keyOk').addEventListener('click', () => Dialog.submitKey());
    $('keyCancel').addEventListener('click', () => Dialog.cancelKey());
    $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') Dialog.submitKey(); });
    $('keyOv').addEventListener('click', (e) => { if (e.target === e.currentTarget) Dialog.cancelKey(); });

    $('setBtn').addEventListener('click', () => { Dialog.open('debugOv'); Debug.refresh(); });
    $('closeDebug').addEventListener('click', () => Dialog.close('debugOv'));
    $('debugOv').addEventListener('click', (e) => { if (e.target === e.currentTarget) Dialog.close('debugOv'); });

    $('dinoBtn').addEventListener('click', () => { Settings.toggleDino(); Debug.refresh(); });
    $('fDefault').addEventListener('input', (e) => Debug.onFormulaInput('default', 'sDefault', e.target.value));
    $('fDino').addEventListener('input', (e) => Debug.onFormulaInput('dino', 'sDino', e.target.value));
    $('fReset').addEventListener('click', () => { Settings.resetFormulas(); Debug.refresh(); });

    $('file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) Background.setImage(file);
      e.target.value = '';
    });
    $('clearBg').addEventListener('click', () => Background.clear());
    $('dim').addEventListener('input', (e) => Background.setDim(Number(e.target.value)));

    $('exportLog').addEventListener('click', () => Log.exportCsv());
    $('importLog').addEventListener('click', () => Debug.startImport());
    $('importFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) Debug.onImportFile(file);
      e.target.value = '';
    });
  }

  /* ========== 14. 起動 ========== */
  function init() {
    Store.load();
    Settings.load();
    Settings.apply();
    Background.load();
    Background.apply();
    if (Background.state.img && !Background.state.acc) {
      Background.extractAccent(Background.state.img, (acc) => {
        if (!acc) return;
        Background.state.acc = acc;
        Background.apply();
        Background.save();
      });
    }
    bindEvents();
    View.render();
    View.tickClock();
    setInterval(() => View.tickClock(), 500);
  }

  init();
})();