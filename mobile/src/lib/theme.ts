// same dark palette as the web app (src/styles.css)
export const colors = {
  page: "#171717",
  panel: "#1d1d1d",
  panelMuted: "#292929",
  line: "rgba(255, 255, 255, 0.09)",
  lineSoft: "rgba(255, 255, 255, 0.055)",
  text: "#ececec",
  strong: "#fafafa",
  muted: "#b0b0b0",
  faint: "#8c8c8c",
  accent: "#dedede",
  accentSoft: "#303030",
  blueSoft: "#282b31",
  blue: "#b9c2d0",
  amberSoft: "#342d22",
  amber: "#d8b477",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = 8;

export const font = { title: 20, body: 15, small: 13, tiny: 11 } as const;
