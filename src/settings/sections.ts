import { AtSign, Bell, Compose, Cpu, Image as ImageIcon, Info, Keyboard, Palette, Plug, Sort } from "../ui/icons";

// Settings shows one section at a time, chosen from its section rail.
export const settingsSections = [
  { id: "accounts", label: "Accounts", description: "Connect email and check each account’s status.", Icon: AtSign },
  { id: "mcp", label: "AI and agents", description: "Set up assistants, keys and account permissions.", Icon: Cpu },
  { id: "connection", label: "Google and connections", description: "Set up Google sign-in and optional sorting providers on this computer.", Icon: Plug },
  { id: "sorting", label: "Sorting and Teach", description: "Review the rules you taught Emc² to organize your mail.", Icon: Sort },
  { id: "compose", label: "Templates and signatures", description: "Reuse message text and add a sign-off to your emails.", Icon: Compose },
  { id: "notifications", label: "Notifications", description: "Choose which floating notices appear and where they show.", Icon: Bell },
  { id: "interaction", label: "Keyboard and mouse", description: "Choose how mail opens and customize your keyboard shortcuts.", Icon: Keyboard },
  { id: "appearance", label: "Appearance", description: "Choose a comfortable theme, reading layout and window style.", Icon: Palette },
  { id: "branding", label: "Sender logos", description: "Fetch and cache company logos for senders.", Icon: ImageIcon },
  { id: "about", label: "About and storage", description: "Understand local storage, sync and what happens when the app closes.", Icon: Info },
] as const;
export type SettingsSection = (typeof settingsSections)[number]["id"];
