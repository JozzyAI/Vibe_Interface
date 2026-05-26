import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import Setup from "./screens/Setup";
import Sessions from "./screens/Sessions";
import SessionDetail from "./screens/SessionDetail";
import Approvals from "./screens/Approvals";
import ApprovalDetail from "./screens/ApprovalDetail";

function Sidebar() {
  const location = useLocation();
  const isSetup = location.pathname === "/setup";
  if (isSetup) return null;
  return (
    <nav style={s.sidebar}>
      <div style={s.logo}>VI</div>
      <NavLink to="/sessions" style={({ isActive }) => ({ ...s.navLink, ...(isActive ? s.navActive : {}) })}>
        Sessions
      </NavLink>
      <NavLink to="/approvals" style={({ isActive }) => ({ ...s.navLink, ...(isActive ? s.navActive : {}) })}>
        Approvals
      </NavLink>
      <div style={{ flex: 1 }} />
      <NavLink to="/setup" style={s.navLink}>
        ⚙ Setup
      </NavLink>
    </nav>
  );
}

function AppRoutes() {
  const [checked, setChecked] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setHasConfig(!!cfg);
      setChecked(true);
    });
  }, []);

  if (!checked) return null;

  return (
    <Routes>
      <Route path="/" element={<Navigate to={hasConfig ? "/sessions" : "/setup"} replace />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/sessions" element={<Sessions />} />
      <Route path="/sessions/:id" element={<SessionDetail />} />
      <Route path="/approvals" element={<Approvals />} />
      <Route path="/approvals/:id" element={<ApprovalDetail />} />
    </Routes>
  );
}

export default function App() {
  return (
    <HashRouter>
      <div style={s.shell}>
        <Sidebar />
        <main style={s.content}>
          <AppRoutes />
        </main>
      </div>
    </HashRouter>
  );
}

type AppStyle = React.CSSProperties & { WebkitAppRegion?: string };
const s: Record<string, AppStyle> = {
  shell: { display: "flex", height: "100vh", background: "#f0f0f0" },
  sidebar: { width: 200, background: "#1a1a1a", display: "flex", flexDirection: "column", padding: "16px 12px", gap: 4, WebkitAppRegion: "drag" },
  logo: { fontSize: 22, fontWeight: 800, color: "#fff", padding: "8px 12px 16px", letterSpacing: 1 },
  navLink: { display: "block", padding: "9px 12px", borderRadius: 7, color: "#aaa", fontSize: 14, fontWeight: 500, textDecoration: "none", WebkitAppRegion: "no-drag" },
  navActive: { background: "#2a2a2a", color: "#fff", fontWeight: 600 },
  content: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
};
