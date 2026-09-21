(() => {
  if (window.__ATP_LOADING__ || window.__ATP_LOADED__) return;
  window.__ATP_LOADING__ = true;
  import(chrome.runtime.getURL("content/main.js")).catch((err) => {
    window.__ATP_LOADING__ = false;
    console.warn("[即译] 脚本加载失败", err);
  });
})();
