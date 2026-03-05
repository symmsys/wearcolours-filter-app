// app/routes/home._index.jsx
import { useLocation, useNavigate } from "react-router";

const HOME_TABS = [
  { label: "Home", path: "/home" },
  { label: "Products", path: "/home/products" },
  { label: "Settings", path: "/home/settings" },
];

export default function HomeIndex() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: "0 0 12px" }}>Quick navigation</h2>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {HOME_TABS.map((t) => {
          const active = location.pathname === t.path;

          return (
            <button
              key={t.path}
              type="button"
              onClick={() => navigate(t.path)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #d0d0d0",
                cursor: "pointer",
                fontWeight: 600,
                opacity: active ? 0.65 : 1,
              }}
              aria-current={active ? "page" : undefined}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 16, color: "#666" }}>
        Tip: If you want these buttons to auto-update when you add new{" "}
        <code>&lt;s-link&gt;</code> items, move the nav items into a shared config
        array and render both nav + buttons from it.
      </div>
    </div>
  );
}