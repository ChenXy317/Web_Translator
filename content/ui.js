export function createUi(handlers) {
  const host = document.createElement("div");
  host.id = "atp-root";
  host.setAttribute("translate", "no");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = "2147483646";
  host.style.pointerEvents = "none";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      .chip {
        position: fixed; pointer-events: auto;
        display: none; align-items: center; gap: 8px;
        background: #0c1222ee; color: #e8eefc; border: 1px solid #243049;
        border-radius: 999px; padding: 8px 10px 8px 12px; font-size: 12px;
        box-shadow: 0 8px 30px #0006; max-width: min(420px, calc(100vw - 24px));
      }
      .chip.show { display: inline-flex; }
      .chip.bottom-right { right: 16px; bottom: 16px; }
      .chip.bottom-left { left: 16px; bottom: 16px; }
      .chip.top-right { right: 16px; top: 16px; }
      .chip.top-left { left: 16px; top: 16px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ee0b0; flex: none; }
      .dot.busy { animation: pulse 1s infinite; }
      .dot.err { background: #ff6b7a; }
      .dot.pause { background: #fbbf24; }
      .meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      #label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
      .bar { display: none; height: 3px; background: #243049; border-radius: 99px; overflow: hidden; width: 120px; }
      .bar.show { display: block; }
      #bar { display: block; height: 100%; width: 0; background: #3ee0b0; }
      .chip button {
        border: 0; background: #1c2744; color: #e8eefc; border-radius: 999px;
        padding: 3px 8px; cursor: pointer; font-size: 11px; flex: none;
      }
      .chip button.hidden { display: none; }
      .tip, .bubble, .ibtn {
        position: fixed; background: #141c31; color: #e8eefc; border: 1px solid #243049;
        box-shadow: 0 10px 30px #0005;
      }
      .tip {
        max-width: 360px; pointer-events: none; border-radius: 8px;
        padding: 8px 10px; font-size: 12px; line-height: 1.45; display: none; z-index: 2;
      }
      .tip.show { display: block; }
      .bubble {
        pointer-events: auto; max-width: 420px; border-radius: 12px;
        padding: 10px 12px; font-size: 13px; line-height: 1.5; display: none; z-index: 3;
      }
      .bubble.show { display: block; }
      .bubble .hd { display: flex; justify-content: space-between; gap: 8px; color: #8b9bb8; font-size: 11px; margin-bottom: 6px; }
      .bubble .ops { display: flex; gap: 6px; margin-top: 8px; }
      .bubble button { border: 0; background: #1c2744; color: #e8eefc; cursor: pointer; border-radius: 8px; padding: 4px 8px; font-size: 11px; }
      .ibtn {
        pointer-events: auto; display: none; z-index: 4; border-radius: 8px;
        padding: 2px 7px; font-size: 11px; cursor: pointer; line-height: 1.4;
      }
      .ibtn.show { display: block; }
      @keyframes pulse { 50% { opacity: .35 } }
    </style>
    <div class="chip bottom-right" id="chip">
      <span class="dot" id="dot"></span>
      <span class="meta">
        <span id="label">即译</span>
        <span class="bar" id="barwrap"><span id="bar"></span></span>
      </span>
      <button id="pause" type="button">暂停</button>
      <button id="retry" class="hidden" type="button">重试</button>
      <button id="act" type="button">还原</button>
      <button id="hide" type="button" title="隐藏面板">×</button>
    </div>
    <div class="tip" id="tip"></div>
    <div class="bubble" id="bubble">
      <div class="hd"><span>选中文本译文</span><button id="close" type="button">关闭</button></div>
      <div id="btext"></div>
      <div class="ops">
        <button id="copy" type="button">复制</button>
        <button id="replace" type="button">替换选区</button>
      </div>
    </div>
    <button class="ibtn" id="ibtn" type="button">译</button>
  `;
  (document.documentElement || document.body).appendChild(host);

  const $ = (id) => shadow.getElementById(id);
  $("act").addEventListener("click", () => handlers.restore());
  $("pause").addEventListener("click", () => handlers.togglePause());
  $("retry").addEventListener("click", () => handlers.retry());
  $("hide").addEventListener("click", () => handlers.hide());
  $("close").addEventListener("click", () => $("bubble").classList.remove("show"));
  $("copy").addEventListener("click", () => handlers.copyBubble());
  $("replace").addEventListener("click", () => handlers.replaceSelection());
  $("ibtn").addEventListener("click", () => handlers.translateInput());

  return {
    root: shadow,
    host,
    chip: $("chip"),
    dot: $("dot"),
    label: $("label"),
    bar: $("bar"),
    barwrap: $("barwrap"),
    pauseBtn: $("pause"),
    retryBtn: $("retry"),
    tip: $("tip"),
    bubble: $("bubble"),
    btext: $("btext"),
    ibtn: $("ibtn")
  };
}

export function setChipPosition(chip, position) {
  chip.classList.remove("bottom-right", "bottom-left", "top-right", "top-left");
  chip.classList.add(position || "bottom-right");
}

export function renderChip(ui, state) {
  if (!ui) return;
  if (state.chipHidden || (!state.enabled && state.phase === "idle")) {
    ui.chip.classList.remove("show");
    return;
  }
  ui.chip.classList.add("show");
  setChipPosition(ui.chip, state.chipPosition);
  ui.dot.className = "dot";
  ui.retryBtn.classList.toggle("hidden", state.phase !== "error");
  ui.pauseBtn.classList.toggle("hidden", !state.enabled || state.phase === "error");
  ui.pauseBtn.textContent = state.paused ? "继续" : "暂停";

  const total = state.done + state.pending;
  if (state.pending > 0 && total > 0) {
    ui.barwrap.classList.add("show");
    ui.bar.style.width = `${Math.round((state.done / total) * 100)}%`;
  } else {
    ui.barwrap.classList.remove("show");
  }

  if (state.phase === "error") {
    ui.dot.classList.add("err");
    ui.label.textContent = state.error || "翻译失败";
  } else if (state.paused) {
    ui.dot.classList.add("pause");
    ui.label.textContent = "已暂停";
  } else if (state.pending > 0) {
    ui.dot.classList.add("busy");
    ui.label.textContent = `翻译中 ${state.done} · 剩余 ${state.pending}`;
  } else {
    ui.label.textContent = `已翻译 ${state.done} 段`;
  }
}

export function showTooltip(ui, text, x, y) {
  ui.tip.textContent = text;
  ui.tip.style.left = `${Math.min(window.innerWidth - 380, x)}px`;
  ui.tip.style.top = `${Math.min(window.innerHeight - 80, y)}px`;
  ui.tip.classList.add("show");
}

export function hideTooltip(ui) {
  ui?.tip.classList.remove("show");
}

export function placeBubble(ui, x, y) {
  ui.bubble.classList.add("show");
  const left = Math.min(window.innerWidth - 440, Math.max(12, x || 24));
  const top = Math.min(window.innerHeight - 160, Math.max(12, y || 24));
  ui.bubble.style.left = `${left}px`;
  ui.bubble.style.top = `${top}px`;
}

export function showInputButton(ui, rect) {
  if (!rect) {
    ui.ibtn.classList.remove("show");
    return;
  }
  ui.ibtn.classList.add("show");
  ui.ibtn.style.left = `${Math.min(window.innerWidth - 40, rect.right - 8)}px`;
  ui.ibtn.style.top = `${Math.max(8, rect.top - 22)}px`;
}
