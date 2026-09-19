import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'eif-theme';

export function currentTheme(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') return 'light';
  return 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6f9' : '#071016');
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Private browsing can block persistence; the toggle still works. */ }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next = theme === 'light' ? 'dark' : 'light';
  return <button className="theme-toggle" type="button" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}
    onClick={() => { applyTheme(next); setTheme(next); }}>
    {next === 'light' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    <span>{next === 'light' ? 'Light mode' : 'Dark mode'}</span>
  </button>;
}
