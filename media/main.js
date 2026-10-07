// @ts-check
(function () {
  // Page globals: acquireVsCodeApi is injected by VS Code, csHighlight by dist/highlight.js.
  const page = /** @type {any} */ (window);
  const vscode = page.acquireVsCodeApi();
  /** @type {(code: string, language: string) => string | null} */
  const highlight = page.csHighlight || (() => null);

  const CARD_WIDTH = 380;
  const GAP = 96; // horizontal space between cards, room for straight arrows
  const PAD = 32;
  const ARC_BASE = 34;
  const ARC_STEP = 26;
  const ARC_MAX = 240;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const CHIPS = ["explain it simpler", "go one level deeper", "why is this here?"];

  /** @typedef {{from:number, kind:"data"|"call", reason:string}} Connection */
  /** @typedef {{id:number, title:string, explanation:string, startLine:number, endLine:number, connections:Connection[]}} Block */
  /** @typedef {{role:"user"|"assistant", text:string}} Turn */

  const el = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const fileEl = el("file");
  const metaEl = el("meta");
  const stateEl = el("state");
  const stageEl = el("stage");
  const boardEl = el("board");
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (el("arrows")));
  const regenerateBtn = /** @type {HTMLButtonElement} */ (el("regenerate"));
  const askEl = el("ask");
  const askScroll = el("ask-scroll");
  const threadEl = el("ask-thread");
  const chipsEl = el("ask-chips");
  const formEl = /** @type {HTMLFormElement} */ (el("ask-form"));
  const questionEl = /** @type {HTMLTextAreaElement} */ (el("question"));
  const zoomEl = el("zoom");
  const zoomLevelEl = /** @type {HTMLButtonElement} */ (el("zoom-level"));
  const modelBtn = el("model");
  const noticeEl = el("notice");
  const historyBtn = el("history");

  /** @type {{fileName:string, languageId:string, storyline:{blocks:Block[]}, lines:string[]} | null} */
  let story = null;
  /** @type {Record<number, Turn[]>} */
  let threads = {};
  /** @type {{blockId:number, text:string} | null} */
  let pending = null;
  /** @type {{blockId:number, question:string, message:string, action?:string} | null} */
  let failed = null;
  /** @type {number | null} */
  let selectedId = null;

  // ---------------------------------------------------------------- messages

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "model":
        el("model-label").textContent = msg.label;
        modelBtn.setAttribute("aria-label", `Model: ${msg.name}. Choose another model`);
        break;
      case "loading":
        story = null;
        closeAsk();
        setHeader(msg.fileName, "");
        setNotice(null);
        historyBtn.hidden = true;
        regenerateBtn.disabled = true;
        showState(`reading ${msg.fileName}…`, null, true);
        break;
      case "error":
        story = null;
        closeAsk();
        setHeader(msg.fileName || "storyline", "");
        setNotice(null);
        historyBtn.hidden = true;
        regenerateBtn.disabled = false;
        showState(msg.message.toLowerCase(), msg.action || null, false);
        break;
      case "storyline": {
        const keep = story && story.fileName === msg.fileName ? selectedId : null;
        story = msg;
        threads = msg.threads || {};
        pending = msg.pending;
        failed = null;
        regenerateBtn.disabled = false;
        const count = msg.storyline.blocks.length;
        setHeader(msg.fileName, `${count} parts · made ${msg.made} with ${msg.modelLabel} · click a part to ask about it`);
        setNotice(msg.notice);
        historyBtn.hidden = false;
        el("history-count").textContent = String(msg.versions);
        historyBtn.setAttribute("aria-label", `History: ${msg.versions} saved storyline${msg.versions === 1 ? "" : "s"} of this file`);
        document.fonts.ready.then(() => {
          renderBoard();
          if (keep && msg.storyline.blocks.some((/** @type {Block} */ b) => b.id === keep)) select(keep, false);
          else closeAsk();
        });
        break;
      }
      case "notice":
        setNotice(msg.notice);
        break;
      case "answer-delta":
        if (pending && pending.blockId === msg.blockId) pending.text += msg.text;
        else pending = { blockId: msg.blockId, text: msg.text };
        if (selectedId === msg.blockId) updateStreaming();
        break;
      case "answer-done":
        (threads[msg.blockId] ||= []).push({ role: "assistant", text: msg.text });
        pending = null;
        if (selectedId === msg.blockId) {
          renderThread();
          renderChips();
        }
        break;
      case "answer-error":
        if (pending && pending.blockId === msg.blockId) {
          threads[msg.blockId]?.pop(); // the question that got no answer
          pending = null;
        }
        failed = { blockId: msg.blockId, question: msg.question, message: msg.message, action: msg.action };
        if (selectedId === msg.blockId) {
          renderThread();
          renderChips();
        }
        break;
    }
  });

  regenerateBtn.addEventListener("click", () => vscode.postMessage({ type: "regenerate" }));
  modelBtn.addEventListener("click", () => vscode.postMessage({ type: "choose-model" }));
  historyBtn.addEventListener("click", () => vscode.postMessage({ type: "history" }));
  vscode.postMessage({ type: "ready" });

  /**
   * @param {string} title
   * @param {string} meta
   */
  function setHeader(title, meta) {
    fileEl.textContent = title;
    metaEl.textContent = meta;
  }

  /**
   * The line under the meta line when the storyline on screen is out of date, with one action to update it.
   * @param {{text:string, action:string} | null} notice
   */
  function setNotice(notice) {
    noticeEl.hidden = !notice;
    noticeEl.replaceChildren();
    if (!notice) return;
    noticeEl.append(notice.text + " ");
    const update = document.createElement("button");
    update.type = "button";
    update.className = "text-action";
    update.textContent = notice.action;
    update.title = "Make a new storyline of the file as it is now. This one stays in the history.";
    update.addEventListener("click", () => vscode.postMessage({ type: "regenerate" }));
    noticeEl.appendChild(update);
  }

  // ---------------------------------------------------------------- states

  /**
   * One mono line, at most one underlined action, or a loading row of placeholder cards.
   * @param {string} text
   * @param {string | null} action "key" | "model" | "retry" | "make"
   * @param {boolean} loading
   */
  function showState(text, action, loading) {
    boardEl.hidden = true;
    zoomEl.hidden = true;
    stageEl.classList.remove("is-canvas");
    stateEl.hidden = false;
    stateEl.replaceChildren();
    if (loading) {
      const row = document.createElement("div");
      row.className = "placeholders";
      for (let i = 0; i < 3; i++) row.appendChild(document.createElement("div")).className = "placeholder";
      stateEl.appendChild(row);
    }
    const line = document.createElement("p");
    line.className = "state-line";
    line.textContent = text;
    if (action) {
      line.append(" ");
      line.appendChild(actionButton(action));
    }
    stateEl.appendChild(line);
  }

  /** The one action after a state or error line. */
  const ACTIONS = {
    key: { label: "set api key", message: "set-key" },
    model: { label: "choose a model", message: "choose-model" },
    make: { label: "make a storyline", message: "regenerate" },
    retry: { label: "try again", message: "regenerate" },
  };

  /** @param {string} action */
  function actionButton(action) {
    const { label, message } = ACTIONS[/** @type {keyof typeof ACTIONS} */ (action)] || ACTIONS.retry;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-action";
    button.textContent = label;
    button.addEventListener("click", () => vscode.postMessage({ type: message }));
    return button;
  }

  // ---------------------------------------------------------------- board

  function renderBoard() {
    if (!story) return;
    stateEl.hidden = true;
    boardEl.hidden = false;
    zoomEl.hidden = false;
    stageEl.classList.add("is-canvas");
    boardEl.querySelectorAll(".card").forEach((c) => c.remove());
    svg.replaceChildren();

    const blocks = story.storyline.blocks;
    const lines = story.lines;

    // 1. Cards first, so their real height (wrapped text + code) can be measured.
    const cards = blocks.map((b) => {
      const card = document.createElement("article");
      card.className = "card";
      card.tabIndex = 0;
      card.dataset.id = String(b.id);
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Part ${b.id}: ${b.title}. Open to see the code and ask about it.`);

      const head = append(card, "header", "card-head");
      append(head, "span", "label", `part ${b.id}`);
      append(head, "span", "lines", b.startLine === b.endLine ? `line ${b.startLine}` : `lines ${b.startLine}–${b.endLine}`);
      append(card, "h2", "card-title", b.title);
      append(card, "p", "card-text", b.explanation);
      card.appendChild(codeExcerpt(lines, b.startLine, b.endLine, story.fileName, story.languageId));

      card.addEventListener("click", () => {
        // Selecting code text inside the card should not count as a click on the card.
        if (String(window.getSelection() || "").length > 0) return;
        select(b.id, true);
      });
      card.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === card) {
          e.preventDefault();
          select(b.id, true);
        }
      });
      card.addEventListener("mouseenter", () => hover(b.id));
      card.addEventListener("mouseleave", () => hover(null));
      boardEl.appendChild(card);
      return card;
    });
    const heights = cards.map((c) => c.offsetHeight);
    const maxHeight = Math.max(...heights);

    // 2. Edges. Neighbours get a straight arrow; longer jumps become arcs,
    //    data above the row and calls below it.
    /** @type {Array<{from:number,to:number,kind:"data"|"call",reason:string,span:number}>} */
    const edges = [];
    blocks.forEach((b, i) =>
      b.connections.forEach((c) => {
        const j = blocks.findIndex((x) => x.id === c.from);
        if (j >= 0 && j < i) edges.push({ from: j, to: i, kind: c.kind, reason: c.reason, span: i - j });
      }),
    );
    const arcHeight = (/** @type {number} */ span) => Math.min(ARC_MAX, ARC_BASE + ARC_STEP * span);
    const tallest = (/** @type {string} */ kind) =>
      Math.max(0, ...edges.filter((e) => e.span > 1 && e.kind === kind).map((e) => arcHeight(e.span)));

    const top = PAD + tallest("data") + 18;
    const xOf = (/** @type {number} */ i) => PAD + i * (CARD_WIDTH + GAP);
    const width = xOf(blocks.length - 1) + CARD_WIDTH + PAD;
    const height = top + maxHeight + tallest("call") + 24 + PAD;

    boardEl.style.width = width + "px";
    boardEl.style.height = height + "px";
    boardSize = { w: width, h: height };
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    cards.forEach((card, i) => {
      card.style.left = xOf(i) + "px";
      card.style.top = top + "px";
    });

    // Spread arc endpoints along each card edge so they don't stack on one point.
    const slotX = (
      /** @type {number} */ boxIndex,
      /** @type {"in"|"out"} */ side,
      /** @type {string} */ edgeKey,
      /** @type {string} */ kind,
    ) => {
      const list = edges
        .filter((e) => e.span > 1 && e.kind === kind && (side === "out" ? e.from : e.to) === boxIndex)
        .sort((a, b) => (side === "out" ? a.to - b.to : b.from - a.from));
      const k = list.findIndex((e) => `${e.from}-${e.to}-${e.kind}` === edgeKey);
      const t = (k + 1) / (list.length + 1);
      // outgoing on the right half, incoming on the left half of the edge
      return xOf(boxIndex) + CARD_WIDTH * (side === "out" ? 0.55 + 0.4 * t : 0.05 + 0.4 * t);
    };

    const path = (/** @type {string} */ d, /** @type {string} */ className) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", className);
      return p;
    };

    edges.forEach((e) => {
      const key = `${e.from}-${e.to}-${e.kind}`;
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("edge", "edge-" + e.kind, "for-" + blocks[e.from].id, "for-" + blocks[e.to].id);

      let d, tipX, tipY, dirX, dirY, labelX, labelY;
      if (e.span === 1) {
        const y = top + 40 + (e.kind === "call" ? 22 : 0);
        const x1 = xOf(e.from) + CARD_WIDTH + 10;
        const x2 = xOf(e.to) - 10;
        d = `M ${x1} ${y} L ${x2} ${y}`;
        [tipX, tipY, dirX, dirY] = [x2, y, 1, 0];
        [labelX, labelY] = [(x1 + x2) / 2, y - 8];
      } else {
        const above = e.kind === "data";
        const h = arcHeight(e.span);
        const x1 = slotX(e.from, "out", key, e.kind);
        const x2 = slotX(e.to, "in", key, e.kind);
        const y1 = above ? top - 8 : top + heights[e.from] + 8;
        const y2 = above ? top - 8 : top + heights[e.to] + 8;
        const base = above ? top - 8 : top + maxHeight + 8;
        const cx = (x1 + x2) / 2;
        const cy = above ? base - 2 * h : base + 2 * h; // a quadratic curve peaks at half its control offset
        d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
        const len = Math.hypot(x2 - cx, y2 - cy);
        [tipX, tipY, dirX, dirY] = [x2, y2, (x2 - cx) / len, (y2 - cy) / len];
        [labelX, labelY] = [cx, above ? base - h - 8 : base + h + 16];
      }
      group.appendChild(path(d, "edge-line"));

      // Arrowhead: an open chevron, always solid.
      const size = 7;
      const bx = tipX - dirX * size;
      const by = tipY - dirY * size;
      const [nx, ny] = [-dirY * size * 0.7, dirX * size * 0.7];
      group.appendChild(path(`M ${bx + nx} ${by + ny} L ${tipX} ${tipY} L ${bx - nx} ${by - ny}`, "edge-head"));

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(labelX));
      label.setAttribute("y", String(labelY));
      label.setAttribute("text-anchor", "middle");
      label.classList.add("edge-label");
      label.textContent = e.kind === "data" ? "data" : "calls";
      group.appendChild(label);

      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `Part ${blocks[e.from].id} to part ${blocks[e.to].id}: ${e.reason}`;
      group.appendChild(title);
      svg.appendChild(group);
    });

    initView();
  }

  /**
   * A part's exact lines as a code block, with real line numbers. Common indentation is trimmed for width.
   * @param {string[]} lines
   * @param {number} start 1-based
   * @param {number} end 1-based, inclusive
   * @param {string} fileName
   * @param {string} language
   */
  function codeExcerpt(lines, start, end, fileName, language) {
    const slice = lines.slice(start - 1, end);
    const indent = Math.min(
      ...slice.filter((l) => l.trim()).map((l) => (/** @type {RegExpMatchArray} */ (l.match(/^[ \t]*/)))[0].length),
    );
    const code = slice.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l)).join("\n");
    return codeBlock(code, language, fileName, start);
  }

  /**
   * @param {string} code
   * @param {string} language
   * @param {string} name shown in the header: the file name, or the language for answers
   * @param {number | null} firstLine line numbers start here; null hides them
   */
  function codeBlock(code, language, name, firstLine) {
    const figure = document.createElement("figure");
    figure.className = "codeblock";
    const head = append(figure, "figcaption", "codeblock-head");
    append(head, "span", "codeblock-name", name);
    const copy = /** @type {HTMLButtonElement} */ (append(head, "button", "codeblock-copy", "copy"));
    copy.type = "button";
    copy.title = "Copy this code";
    copy.addEventListener("click", (e) => {
      e.stopPropagation(); // copying is not selecting the card
      vscode.postMessage({ type: "copy", text: code });
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1600);
    });

    const body = append(figure, "div", "code");
    if (firstLine !== null) {
      const count = code.split("\n").length;
      append(body, "pre", "code-gutter", Array.from({ length: count }, (_, i) => String(firstLine + i)).join("\n"));
    }
    const pre = append(body, "pre", "code-text");
    const codeEl = append(pre, "code", "");
    const html = highlight(code, language);
    if (html !== null) codeEl.innerHTML = html; // Prism escapes the code, so this is safe
    else codeEl.textContent = code;
    return figure;
  }

  /** @param {number | null} id */
  function hover(id) {
    // Fade the arrows that don't touch the hovered card.
    svg.querySelectorAll(".edge").forEach((g) => g.classList.toggle("dim", id !== null && !g.classList.contains("for-" + id)));
  }

  // ---------------------------------------------------------------- canvas: move and zoom
  // The storyline moves and zooms like a canvas. Cards keep their places; only the view changes.

  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 2;
  const EDGE = 24; // room between a card and the edge of the view
  let view = { x: 0, y: 0, k: 1 };
  let boardSize = { w: 0, h: 0 };

  const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
  const panelSpace = () => (askEl.classList.contains("open") ? askEl.offsetWidth : 0);

  /** @param {boolean} [animate] */
  function applyView(animate) {
    // Never lose the storyline: at least 80px of it stays on screen.
    view.x = clamp(view.x, 80 - boardSize.w * view.k, stageEl.clientWidth - 80);
    view.y = clamp(view.y, 80 - boardSize.h * view.k, stageEl.clientHeight - 80);
    boardEl.classList.toggle("animate", !!animate);
    boardEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    zoomLevelEl.textContent = `${Math.round(view.k * 100)}%`;
    zoomLevelEl.title = isFitted() ? "Back to 100% (0)" : "Fit the whole storyline (0)";
    if (story) {
      vscode.setState({ ...(vscode.getState() || {}), view: { file: story.fileName, parts: story.storyline.blocks.length, ...view } });
    }
  }

  /** The zoom at which the whole storyline fits beside the panel, never above 100%. */
  function fitScale() {
    const w = stageEl.clientWidth - panelSpace() - 2 * EDGE;
    const h = stageEl.clientHeight - 2 * EDGE;
    return clamp(Math.min(1, w / boardSize.w, h / boardSize.h), MIN_ZOOM, 1);
  }

  const isFitted = () => Math.abs(view.k - fitScale()) < 0.005;

  function fit() {
    const k = fitScale();
    view = {
      k,
      x: (stageEl.clientWidth - panelSpace() - boardSize.w * k) / 2,
      y: Math.max(EDGE, (stageEl.clientHeight - boardSize.h * k) / 2),
    };
  }

  /**
   * Zooms to k while the point (px, py) of the view stays where it is.
   * @param {number} px
   * @param {number} py
   * @param {number} k
   */
  function zoomAt(px, py, k) {
    k = clamp(k, MIN_ZOOM, MAX_ZOOM);
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
  }

  /** @param {number} factor */
  function zoomBy(factor) {
    zoomAt((stageEl.clientWidth - panelSpace()) / 2, stageEl.clientHeight / 2, view.k * factor);
    applyView(true);
  }

  function fitOrReset() {
    if (isFitted()) zoomAt((stageEl.clientWidth - panelSpace()) / 2, stageEl.clientHeight / 2, 1);
    else fit();
    applyView(true);
  }

  /** A new storyline starts at 100%; the same file shown again keeps where you left it. */
  function initView() {
    const saved = (vscode.getState() || {}).view;
    if (story && saved && saved.file === story.fileName && saved.parts === story.storyline.blocks.length) {
      view = { x: saved.x, y: saved.y, k: saved.k };
    } else {
      view = { x: 0, y: 0, k: 1 };
    }
    applyView(false);
  }

  el("zoom-in").addEventListener("click", () => zoomBy(1.25));
  el("zoom-out").addEventListener("click", () => zoomBy(0.8));
  zoomLevelEl.addEventListener("click", fitOrReset);
  new ResizeObserver(() => !boardEl.hidden && applyView(false)).observe(stageEl);

  // Ctrl/⌘ + wheel and trackpad pinches (which arrive as ctrl + wheel) zoom around the pointer.
  // Plain wheels and two-finger swipes move the view; code inside a card scrolls first.
  stageEl.addEventListener(
    "wheel",
    (e) => {
      if (boardEl.hidden) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = stageEl.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY * 0.002));
        applyView(false);
        return;
      }
      const code = /** @type {HTMLElement} */ (e.target).closest(".code");
      if (code && canScroll(/** @type {HTMLElement} */ (code), e.deltaX, e.deltaY)) return;
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      // A mouse wheel moves along the story when the storyline already fits top to bottom.
      if (!dx && (e.shiftKey || boardSize.h * view.k <= stageEl.clientHeight)) [dx, dy] = [dy, 0];
      view.x -= dx;
      view.y -= dy;
      applyView(false);
    },
    { passive: false },
  );

  /**
   * @param {HTMLElement} node
   * @param {number} dx
   * @param {number} dy
   */
  function canScroll(node, dx, dy) {
    if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    return dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
  }

  // Drag to move. The left button works anywhere except inside code (so code can be selected);
  // the middle button works everywhere.
  /** @type {{id:number, sx:number, sy:number, x:number, y:number, moved:boolean} | null} */
  let drag = null;
  let justMoved = false;
  stageEl.addEventListener("pointerdown", (e) => {
    if (boardEl.hidden) return;
    if (e.button === 1) e.preventDefault();
    else if (e.button !== 0 || /** @type {HTMLElement} */ (e.target).closest(".code, button, textarea")) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
  });
  stageEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      stageEl.setPointerCapture(e.pointerId);
      stageEl.classList.add("is-moving");
    }
    view.x = drag.x + dx;
    view.y = drag.y + dy;
    applyView(false);
  });
  const endDrag = (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      justMoved = true;
      setTimeout(() => (justMoved = false), 0);
    }
    stageEl.classList.remove("is-moving");
    drag = null;
  };
  stageEl.addEventListener("pointerup", endDrag);
  stageEl.addEventListener("pointercancel", endDrag);
  stageEl.addEventListener(
    "click",
    (e) => {
      // A drag is not a click: moving the view never selects a card.
      if (justMoved) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // Clicking empty space closes the panel.
      if (!(/** @type {HTMLElement} */ (e.target).closest(".card")) && askEl.classList.contains("open")) closeAsk();
    },
    true,
  );

  // Keys: + and - zoom, 0 fits (or goes back to 100%), arrows move.
  document.addEventListener("keydown", (e) => {
    if (boardEl.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/** @type {HTMLElement} */ (e.target).closest("textarea, input")) return;
    const step = 80;
    switch (e.key) {
      case "+":
      case "=":
        zoomBy(1.25);
        break;
      case "-":
      case "_":
        zoomBy(0.8);
        break;
      case "0":
        fitOrReset();
        break;
      case "ArrowLeft":
        view.x += step;
        applyView(true);
        break;
      case "ArrowRight":
        view.x -= step;
        applyView(true);
        break;
      case "ArrowUp":
        view.y += step;
        applyView(true);
        break;
      case "ArrowDown":
        view.y -= step;
        applyView(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  /** Moves the view so the chosen card is fully visible beside the open panel. */
  function panToCard(/** @type {number} */ id) {
    const card = /** @type {HTMLElement | null} */ (boardEl.querySelector(`.card[data-id="${id}"]`));
    if (!card) return;
    const left = view.x + card.offsetLeft * view.k;
    const right = view.x + (card.offsetLeft + card.offsetWidth) * view.k;
    const top = view.y + card.offsetTop * view.k;
    const maxRight = stageEl.clientWidth - panelSpace() - EDGE;
    let x = view.x;
    let y = view.y;
    if (right > maxRight) x -= right - maxRight;
    if (left + (x - view.x) < EDGE) x = view.x + (EDGE - left);
    if (top < EDGE || top > stageEl.clientHeight - 120) y += EDGE - top;
    if (x !== view.x || y !== view.y) {
      view.x = x;
      view.y = y;
      applyView(true);
    }
  }

  const isMac = /Mac/.test(navigator.platform);
  el("zoom-hint").textContent = `drag to move \u00b7 ${isMac ? "\u2318" : "ctrl"} + scroll to zoom`;

  // ---------------------------------------------------------------- selection and the ask panel

  /**
   * @param {number} id
   * @param {boolean} jump also select the lines in the editor
   */
  function select(id, jump) {
    if (!story) return;
    const block = story.storyline.blocks.find((b) => b.id === id);
    if (!block) return;
    selectedId = id;
    // Only highlights the lines if the file is already visible; it never opens the file.
    if (jump) vscode.postMessage({ type: "reveal", startLine: block.startLine, endLine: block.endLine, open: false });
    boardEl.querySelectorAll(".card").forEach((c) => c.classList.toggle("is-selected", c.getAttribute("data-id") === String(id)));
    openAsk(block);
    panToCard(id);
  }

  /** @param {Block} block */
  function openAsk(block) {
    if (!story) return;
    el("ask-label").textContent =
      block.startLine === block.endLine
        ? `part ${block.id} · line ${block.startLine}`
        : `part ${block.id} · lines ${block.startLine}–${block.endLine}`;
    el("ask-title").textContent = block.title;
    el("ask-text").textContent = block.explanation;

    // How this part connects, in words, so nobody has to hover the arrows to find out.
    const links = el("ask-links");
    links.replaceChildren();
    const blocks = story.storyline.blocks;
    const rows = [
      ...block.connections.map((c) => ({ id: c.from, label: `uses part ${c.from} · ${c.kind === "data" ? "data" : "calls"}`, reason: c.reason })),
      ...blocks.flatMap((b) =>
        b.connections
          .filter((c) => c.from === block.id)
          .map((c) => ({ id: b.id, label: `used by part ${b.id} · ${c.kind === "data" ? "data" : "calls"}`, reason: c.reason })),
      ),
    ];
    rows.forEach((r) => {
      const row = append(links, "button", "link-row");
      /** @type {HTMLButtonElement} */ (row).type = "button";
      append(row, "span", "label", r.label);
      append(row, "span", "link-text", r.reason);
      row.addEventListener("click", () => select(r.id, true));
    });

    if (failed && failed.blockId !== block.id) failed = null;
    renderThread(false);
    renderChips();
    askScroll.scrollTop = 0; // a part opens at its title; new questions and answers scroll down
    askEl.classList.add("open");
    askEl.removeAttribute("aria-hidden");
    askEl.inert = false;
  }

  function closeAsk() {
    const wasOpen = askEl.classList.contains("open");
    askEl.classList.remove("open");
    askEl.setAttribute("aria-hidden", "true");
    askEl.inert = true;
    const card = /** @type {HTMLElement | null} */ (boardEl.querySelector(`.card[data-id="${selectedId}"]`));
    selectedId = null;
    boardEl.querySelectorAll(".card.is-selected").forEach((c) => c.classList.remove("is-selected"));
    if (wasOpen) vscode.postMessage({ type: "unhighlight" });
    if (wasOpen && card) card.focus({ preventScroll: true });
  }

  el("ask-close").addEventListener("click", closeAsk);
  el("ask-open").addEventListener("click", () => {
    const block = story?.storyline.blocks.find((b) => b.id === selectedId);
    if (block) vscode.postMessage({ type: "reveal", startLine: block.startLine, endLine: block.endLine, open: true });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && askEl.classList.contains("open") && !e.isComposing) closeAsk();
  });

  /** @param {boolean} [scrollToEnd] */
  function renderThread(scrollToEnd = true) {
    threadEl.replaceChildren();
    if (selectedId === null) return;
    for (const turn of threads[selectedId] || []) {
      if (turn.role === "user") append(threadEl, "p", "q", turn.text);
      else richText(append(threadEl, "div", "a"), turn.text);
    }
    if (pending && pending.blockId === selectedId) {
      append(threadEl, "div", "a streaming");
      updateStreaming();
    }
    if (failed && failed.blockId === selectedId) {
      append(threadEl, "p", "q is-failed", failed.question);
      const line = append(threadEl, "p", "a-error", failed.message.toLowerCase() + " ");
      if (failed.action && failed.action !== "retry") {
        line.appendChild(actionButton(failed.action));
      } else {
        // Trying again re-asks the same question here, rather than remaking the storyline.
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "text-action";
        retry.textContent = "try again";
        const question = failed.question;
        retry.addEventListener("click", () => send(question));
        line.appendChild(retry);
      }
    }
    if (scrollToEnd) askScroll.scrollTop = askScroll.scrollHeight;
  }

  /** Re-draws the answer that is still arriving, keeping the view pinned to the bottom. */
  function updateStreaming() {
    const target = threadEl.querySelector(".streaming");
    if (!target || !pending) return;
    const atBottom = askScroll.scrollHeight - askScroll.scrollTop - askScroll.clientHeight < 40;
    if (pending.text) richText(/** @type {HTMLElement} */ (target), pending.text);
    else {
      target.replaceChildren();
      append(target, "p", "thinking", "thinking…");
    }
    if (atBottom) askScroll.scrollTop = askScroll.scrollHeight;
  }

  function renderChips() {
    chipsEl.replaceChildren();
    const busy = pending !== null;
    for (const text of CHIPS) {
      const chip = /** @type {HTMLButtonElement} */ (append(chipsEl, "button", "chip", text));
      chip.type = "button";
      chip.disabled = busy;
      chip.addEventListener("click", () => send(text));
    }
    questionEl.disabled = busy;
    questionEl.placeholder = busy ? "answering…" : "ask about this part…";
  }

  /** @param {string} question */
  function send(question) {
    question = question.trim();
    if (selectedId === null || !question || pending) return;
    (threads[selectedId] ||= []).push({ role: "user", text: question });
    pending = { blockId: selectedId, text: "" };
    failed = null;
    vscode.postMessage({ type: "ask", blockId: selectedId, question });
    questionEl.value = "";
    sizeComposer();
    renderThread();
    renderChips();
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    send(questionEl.value);
  });
  questionEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(questionEl.value);
    }
  });
  questionEl.addEventListener("input", sizeComposer);

  function sizeComposer() {
    questionEl.style.height = "auto";
    questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + "px";
    formEl.classList.toggle("has-text", questionEl.value.trim().length > 0);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * @param {Element} parent
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   */
  function append(parent, tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  /**
   * A tiny, safe renderer for Claude's answers: paragraphs, ordered and bulleted lists,
   * ``` code blocks, `inline code` and **bold**. Builds DOM nodes, never HTML strings.
   * @param {HTMLElement} target
   * @param {string} text
   */
  function richText(target, text) {
    target.replaceChildren();
    const fences = [...text.matchAll(/```([^\n]*)\n?/g)].map((m) => m[1].trim());
    text.split(/```[^\n]*\n?/).forEach((part, i) => {
      if (i % 2 === 1) {
        const language = fences[(i - 1) / 2] || story?.languageId || "";
        target.appendChild(codeBlock(part.replace(/\n$/, ""), language, language || "code", null));
        return;
      }
      for (const para of part.split(/\n{2,}/)) {
        const lines = para.split("\n").filter((l) => l.trim());
        if (!lines.length) continue;
        const ordered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
        const bulleted = lines.every((l) => /^\s*[-*•]\s+/.test(l));
        if (ordered || bulleted) {
          const list = append(target, ordered ? "ol" : "ul", "");
          lines.forEach((l) => inline(append(list, "li", ""), l.replace(/^\s*(\d+[.)]|[-*•])\s+/, "")));
        } else {
          const p = append(target, "p", "");
          lines.forEach((l, k) => {
            if (k) p.appendChild(document.createElement("br"));
            inline(p, l);
          });
        }
      }
    });
  }

  /**
   * @param {HTMLElement} parent
   * @param {string} text
   */
  function inline(parent, text) {
    text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).forEach((piece) => {
      if (/^`[^`]+`$/.test(piece)) append(parent, "code", "", piece.slice(1, -1));
      else if (/^\*\*[^*]+\*\*$/.test(piece)) append(parent, "strong", "", piece.slice(2, -2));
      else if (piece) parent.appendChild(document.createTextNode(piece));
    });
  }

  closeAsk();
})();
