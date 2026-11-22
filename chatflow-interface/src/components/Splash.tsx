/** What shows while the app works out who you are — never a blank white screen. */
export function Splash({ label }: { label?: string }) {
  return (
    <div className="grid h-[100dvh] w-full place-items-center bg-background">
      <div className="flex flex-col items-center gap-4 animate-in fade-in-0 duration-300">
        <img
          src="/logo.png"
          alt=""
          className="h-14 w-14 animate-pulse rounded-2xl bg-black object-cover"
        />
        <span className="text-[13px] text-muted-foreground">{label ?? "Loading jobpilot…"}</span>
      </div>
    </div>
  );
}
