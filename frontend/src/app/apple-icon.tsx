import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0a0a0a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="120"
          height="120"
          viewBox="0 0 512 512"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M 356 176 A 112 112 0 1 0 356 336"
            fill="none"
            stroke="#ffffff"
            strokeWidth="56"
            strokeLinecap="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
