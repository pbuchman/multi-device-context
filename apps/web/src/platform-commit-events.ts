/** Chromium's IME commit sentinel is only a candidate shape, never caller identity. */
export function platformCommitKey(event: Event): boolean {
 const key = event as KeyboardEvent;
 return (event.type === "keydown" || event.type === "keyup") && event.isTrusted && key.key === "Unidentified" && key.code === "" && key.keyCode === 229
  && key.isComposing === false && !key.repeat && !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey;
}
function insertionEvent(event: Event): boolean {
 const input = event as InputEvent;
 return event.isTrusted && input.isComposing === false && input.inputType === "insertText";
}
/** One fixed bound covers the whole sequence and fresh native confirmation. It grants no send authority. */
export class PlatformCommitEvents {
 private stage: "down" | "before" | "input" | "up" | "proof" | "accepted" | "invalid" = "down";
 private readonly deadline: number;
 private readonly timer: ReturnType<typeof setTimeout>;
 constructor(private readonly target: EventTarget, private readonly confirm: () => Promise<void>, private readonly current: (phase: "event" | "input-capture" | "proof") => boolean, private readonly reject: () => void, private readonly clock: () => number = () => performance.now()) {
  this.deadline = this.clock() + 1000;
  this.timer = setTimeout(() => this.fail(), 1000);
 }
 get pending() { return this.stage !== "accepted" && this.stage !== "invalid"; }
 get accepted() { return this.stage === "accepted"; }
 dispose() { clearTimeout(this.timer); this.stage = "invalid"; }
 private fail() { if (this.stage === "invalid") return; this.dispose(); this.reject(); }
 observe(event: Event): void {
  if (this.stage === "invalid") return;
  const expectedInput = this.stage === "input" && event.type === "input" && insertionEvent(event);
  if (this.clock() >= this.deadline || event.target !== this.target || !this.current(expectedInput ? "input-capture" : "event")) { this.fail(); return; }
  if (this.stage === "down" && event.type === "keydown" && platformCommitKey(event)) this.stage = "before";
  else if (this.stage === "before" && event.type === "beforeinput" && insertionEvent(event)) this.stage = "input";
  else if (this.stage === "input" && event.type === "input" && insertionEvent(event)) this.stage = "up";
  else if (this.stage === "up" && event.type === "keyup" && platformCommitKey(event)) {
   this.stage = "proof";
   void this.confirm().then(() => {
    if (this.stage === "invalid") return;
    if (this.clock() >= this.deadline || this.stage !== "proof" || !this.current("proof")) { this.fail(); return; }
    clearTimeout(this.timer); this.stage = "accepted";
   }).catch(() => this.fail());
  } else this.fail();
 }
}
