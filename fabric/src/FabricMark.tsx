// Compute tiles joined by short routes; intentionally monochrome and geometric.
export default function FabricMark() {
  return <svg className="brand-mark" viewBox="4 4 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="M7 7h7v7H7zM18 7h7v7h-7zM7 18h7v7H7zM18 18h7v7h-7z" fill="currentColor" />
    <path d="M14 10.5h4M10.5 14v4M21.5 14v4M14 21.5h4" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
  </svg>;
}
