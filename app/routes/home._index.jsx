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
  {
    title: "Sort",
    desc: "Sort products manually.",
    path: "/home/product-sort",
    icon: "drag",
  },
  {
    title: "Club Customers",
    desc: "Manage club customer profiles.",
    path: "/home/club-customers",
    icon: "user",
  },
];

const LOGO_SRC = "/Colours_UNIFORMS-Logo.jpg";

export default function HomeIndex() {
  const navigate = useNavigate();

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <img src={LOGO_SRC} alt="App Logo" style={styles.logo} />
      </div>

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

function getIcon(type) {
  if (type === "gear") {
    return <span>⚙️</span>;
  }

  if (type === "tag") {
    return <span>🏷️</span>;
  }

  if (type === "drag") {
    return <span>↕️</span>;
  }

  if (type === "user") {
    return <span>👤</span>;
  }
  return <span>•</span>;
}

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
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#f6f6f7",
    borderRadius: 12,
    padding: 18,
    cursor: "pointer",
    border: "1px solid #e3e3e3",
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