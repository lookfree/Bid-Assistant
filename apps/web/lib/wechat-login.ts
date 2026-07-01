// 微信网站应用 wxLogin.js 的最小 typed 封装：隔离运行时注入的全局，页面不必再写 @ts-expect-error。
type WxLoginParams = {
  id: string
  appid: string
  scope: string
  redirect_uri: string // 需已 encodeURIComponent
  state: string
}
type WxLoginCtor = new (params: WxLoginParams) => unknown

declare global {
  interface Window {
    WxLogin?: WxLoginCtor
  }
}

// 按需加载官方脚本并把二维码渲染到 params.id 容器（先清空容器，避免叠加旧的、带不同 state 的二维码）。
export async function renderWxLogin(params: WxLoginParams): Promise<void> {
  await loadScript()
  const Ctor = window.WxLogin
  if (!Ctor) throw new Error("WxLogin 未就绪")
  const mount = document.getElementById(params.id)
  if (mount) mount.innerHTML = ""
  new Ctor(params)
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.WxLogin) return resolve()
    const s = document.createElement("script")
    s.src = "https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js"
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("wxLogin.js 加载失败"))
    document.head.appendChild(s)
  })
}
