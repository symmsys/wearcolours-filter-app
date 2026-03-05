import { useNavigate } from "react-router";

/**
 * Update these whenever you add/remove tabs.
 * If you want this to auto-update from your <s-link> list,
 * tell me and I will convert your nav to a shared config file.
 */
const HOME_CARDS = [
  {
    title: "Products",
    desc: "Manage products and run sync operations.",
    path: "/home/products",
  },
  {
    title: "Settings",
    desc: "Configure app settings and preferences.",
    path: "/home/settings",
  },
];

// Put your logo file in: /public/logo.png
// Then this will work: <img src="/logo.png" ... />
const LOGO_SRC = "/Colours_UNIFORMS-Logo.jpg";

export default function HomeIndex() {
  const navigate = useNavigate();

  return (
    <div style={styles.page}>
      {/* Top logo area */}
      <div style={styles.header}>
        <div style={styles.logoWrap}>
          <img
            src={LOGO_SRC}
            alt="App logo"
            style={styles.logoImg}
            onError={(e) => {
              // If logo missing, hide the broken image icon
              e.currentTarget.style.display = "none";
            }}
          />
        </div>
      </div>

      {/* Cards */}
      <div style={styles.grid}>
        {HOME_CARDS.map((c) => (
          <div
            key={c.path}
            role="button"
            tabIndex={0}
            onClick={() => navigate(c.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") navigate(c.path);
            }}
            style={styles.card}
          >
            <div style={styles.cardTitle}>{c.title}</div>
            <div style={styles.cardDesc}>{c.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  page: {
    padding: 20,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    marginBottom: 16,
  },
  logoWrap: {
    width: "100%",
    display: "flex",
    justifyContent: "flex-start",
  },
  logoImg: {
    height: 40,
    width: "auto",
    objectFit: "contain",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 12,
    padding: 16,
    cursor: "pointer",
    userSelect: "none",
    boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
    transition: "transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease",
    outline: "none",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 6,
    color: "#1f1f1f",
  },
  cardDesc: {
    fontSize: 13,
    lineHeight: 1.4,
    color: "#6b6b6b",
  },
};