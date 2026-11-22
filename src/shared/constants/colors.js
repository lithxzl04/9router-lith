// Purple palette for 9router-lith (Paper / Charcoal / AMOLED)
// Mirror of src/app/globals.css tokens for runtime JS consumers.

export const COLORS = {
  // Primary — Royal / Amethyst Purple
  primary: {
    DEFAULT: "#461E9E",
    hover: "#5829BE",
    dark: "#7C3AED",
    darkHover: "#8B5CF6",
    amoled: "#6D28D9",
  },

  brass: {
    DEFAULT: "#7C5CE6",
    light: "#B7A4F8",
    dark: "#A78BFA",
    amoled: "#C4B5FD",
  },

  // Paper (Light) theme
  light: {
    bg: "#F7F5FC",
    bgAlt: "#F0ECF9",
    surface: "#FFFFFF",
    sidebar: "#F7F5FC",
    border: "#DCD5EC",
    textMain: "#1E1A2B",
    textMuted: "#635C78",
  },

  // Charcoal (Dark) theme
  dark: {
    bg: "#121018",
    bgAlt: "#181520",
    surface: "#181520",
    sidebar: "#121018",
    border: "#2D283E",
    textMain: "#EAE6F5",
    textMuted: "#9B93B3",
  },

  // AMOLED True Black theme
  amoled: {
    bg: "#000000",
    bgAlt: "#06050A",
    surface: "#0B0912",
    sidebar: "#000000",
    border: "#211C30",
    textMain: "#F3F0FA",
    textMuted: "#9E96B8",
  },

  // Status colors — solid & quiet
  status: {
    success: "#2E6F4E",
    warning: "#B4691E",
    error: "#B83A3A",
    info: "#6D3CD9",
  },
};

// CSS Variables mapping
export const CSS_VARIABLES = {
  light: {
    "--color-primary": COLORS.primary.DEFAULT,
    "--color-primary-hover": COLORS.primary.hover,
    "--color-bg": COLORS.light.bg,
    "--color-bg-alt": COLORS.light.bgAlt,
    "--color-surface": COLORS.light.surface,
    "--color-sidebar": COLORS.light.sidebar,
    "--color-border": COLORS.light.border,
    "--color-text-main": COLORS.light.textMain,
    "--color-text-muted": COLORS.light.textMuted,
  },
  dark: {
    "--color-primary": COLORS.primary.dark,
    "--color-primary-hover": COLORS.primary.darkHover,
    "--color-bg": COLORS.dark.bg,
    "--color-bg-alt": COLORS.dark.bgAlt,
    "--color-surface": COLORS.dark.surface,
    "--color-sidebar": COLORS.dark.sidebar,
    "--color-border": COLORS.dark.border,
    "--color-text-main": COLORS.dark.textMain,
    "--color-text-muted": COLORS.dark.textMuted,
  },
  amoled: {
    "--color-primary": COLORS.primary.amoled,
    "--color-primary-hover": COLORS.primary.darkHover,
    "--color-bg": COLORS.amoled.bg,
    "--color-bg-alt": COLORS.amoled.bgAlt,
    "--color-surface": COLORS.amoled.surface,
    "--color-sidebar": COLORS.amoled.sidebar,
    "--color-border": COLORS.amoled.border,
    "--color-text-main": COLORS.amoled.textMain,
    "--color-text-muted": COLORS.amoled.textMuted,
  },
};
