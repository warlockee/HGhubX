import { useStore } from "./index";

/** AppShell 切片：窗口、主题、导航、门牌等外壳状态。 */
export function useAppShellStore() {
  const s = useStore();
  return {
    platform: s.platform,
    theme: s.theme, setTheme: s.setTheme,
    tab: s.tab, setTab: s.setTab,
    stack: s.stack, push: s.push, pop: s.pop,
    loginOpen: s.loginOpen, setLoginOpen: s.setLoginOpen,
    gate: s.gate, gateReady: s.gateReady, gateBusy: s.gateBusy, gateError: s.gateError,
    activateGate: s.activateGate, resetGate: s.resetGate,
    toast: s.toast, toasts: s.toasts,
    lineEpoch: s.lineEpoch, libraryEpoch: s.libraryEpoch, refreshLibrary: s.refreshLibrary,
    strictSecurity: s.strictSecurity, strictSecurityReady: s.strictSecurityReady,
    securityPending: s.securityPending, cliRelaxed: s.cliRelaxed, setStrictSecurity: s.setStrictSecurity,
  };
}
