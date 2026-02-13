import { redirect } from "react-router";

export const loader = async ({ request }) => {
    const url = new URL(request.url);

    if (url.searchParams.get("shop")) {
        throw redirect(`/app?${url.searchParams.toString()}`);
    }

    return null;
};

export default function App() {
    return (
        <div
            style={{
                height: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#ffffff",
            }}
        >
            <img
                src="/Colours_UNIFORMS-Logo.jpg"
                alt="Colours Uniforms"
                style={{
                    maxWidth: "300px",
                    width: "100%",
                    height: "auto",
                }}
            />
        </div>
    );
}
