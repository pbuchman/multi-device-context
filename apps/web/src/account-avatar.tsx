export function AccountAvatar({ name, avatarUrl, large = false }: { name: string; avatarUrl?: string | undefined; large?: boolean }) {
  return <span className={`avatar${large ? " large" : ""}`} aria-hidden="true">
    {name.charAt(0).toUpperCase()}
    {avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /> : null}
  </span>;
}
