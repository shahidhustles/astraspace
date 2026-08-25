function Mark() {
  return (
    <span
      aria-hidden
      className="grid h-6 w-6 place-items-center rounded-[6px] border border-border-quiet bg-space-850"
    >
      <span className="h-2 w-2 rounded-[2px] bg-orbit-400" />
    </span>
  );
}

export default function App() {
  return (
    <div className="flex h-full flex-col bg-space-950">
      <header className="flex items-center justify-between gap-3 border-b border-border-quiet bg-space-900 px-4 py-3 shadow-rim-panel">
        <div className="flex items-center gap-2.5">
          <Mark />
          <div>
            <p className="text-[15px] font-medium leading-[1.35] text-ink-50">Astra Space</p>
            <p className="text-[11px] leading-[1.35] text-ink-400">Local agent</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-border-quiet bg-space-850 px-2.5 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-orbit-400" />
          <span className="text-[11px] font-medium leading-[1.3] text-ink-200">Local</span>
        </span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[28px] font-medium leading-[1.18] text-ink-50">Nothing sent yet</p>
        <p className="max-w-[28ch] text-[13px] leading-[1.45] text-ink-400">
          Describe a task. The agent reads this page, strips private values, and only then sends
          sanitized context to the model.
        </p>
      </main>

      <footer className="border-t border-border-quiet px-4 py-3">
        <p className="text-center text-[11px] leading-[1.35] text-ink-600">
          Local processing. Outbound context is sanitized before it leaves this device.
        </p>
      </footer>
    </div>
  );
}
