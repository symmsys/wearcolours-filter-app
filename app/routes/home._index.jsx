import { useNavigate } from "react-router";

const HOME_CARDS = [
  {
    title: "Products",
    desc: "Manage products and sync collections.",
    path: "/home/products",
    icon: "tag",
  },
  {
    title: "Settings",
    desc: "Configure application settings.",
    path: "/home/settings",
    icon: "gear",
  },
];

const LOGO_SRC = "/Colours_UNIFORMS-Logo.jpg";

export default function HomeIndex() {
  const navigate = useNavigate();

  return (
    <div style={styles.page}>

      {/* Logo */}
      <div style={styles.header}>
        <img src={LOGO_SRC} alt="App Logo" style={styles.logo} />
      </div>

      {/* Cards */}
      <div style={styles.grid}>
        {HOME_CARDS.map((card) => (
          <div
            key={card.path}
            style={styles.card}
            onClick={() => navigate(card.path)}
          >
            <div style={styles.icon}>{getIcon(card.icon)}</div>

            <div style={styles.title}>{card.title}</div>
            <div style={styles.desc}>{card.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- ICONS ---------- */

function getIcon(type) {
  if (type === "gear") {
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5A3.5 3.5 0 0 0 12 15.5Z" stroke="#444" strokeWidth="2" />
        <path d="M19.4 15a7.8 7.8 0 0 0 .1-2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-1.7-1l-.3-2.6h-4l-.3 2.6c-.6.2-1.2.5-1.7 1l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.5 2.4-1c.5.4 1.1.7 1.7 1l.3 2.6h4l.3-2.6c.6-.2 1.2-.5 1.7-1l2.4 1 2-3.5-2-1.5z"
          stroke="#444"
          strokeWidth="2"
        />
      </svg>
    );
  }

  if (type === "tag") {
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <path
          d="M20 12L12 20L4 12V4H12L20 12Z"
          stroke="#444"
          strokeWidth="2"
        />
        <circle cx="9" cy="9" r="1.5" fill="#444" />
      </svg>
    );
  }

  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M3 10L12 3L21 10V21H3V10Z" stroke="#444" strokeWidth="2" />
    </svg>
  );
}

/* ---------- STYLES ---------- */

const styles = {
  page: {
    padding: 20,
  },

  header: {
    marginBottom: 20,
  },

  logo: {
    height: 40,
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px,1fr))",
    gap: 16,
  },

  card: {
    background: "#f6f6f7",
    borderRadius: 12,
    padding: 18,
    cursor: "pointer",
    border: "1px solid #e3e3e3",
    transition: "all .15s ease",
  },

  icon: {
    marginBottom: 10,
  },

  title: {
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 4,
  },

  desc: {
    fontSize: 13,
    color: "#666",
  },
};