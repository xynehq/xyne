type Props = {
  name?: string | undefined
}

const timeGreeting = (now = new Date()): string => {
  const h = now.getHours()
  if (h < 5) {
    return "Working late"
  }
  if (h < 12) {
    return "Good morning"
  }
  if (h < 17) {
    return "Good afternoon"
  }
  return "Good evening"
}

const firstName = (email?: string): string | undefined => {
  if (!email) {
    return undefined
  }
  const local = email.split("@")[0] ?? ""
  const first = local.split(/[._-]+/)[0]
  if (!first) {
    return undefined
  }
  return first.charAt(0).toUpperCase() + first.slice(1)
}

export function EmptyState({ name }: Props): JSX.Element {
  const greet = timeGreeting()
  const display = firstName(name)

  return (
    <h1 className="animate-fade-up text-center text-[28px] font-normal leading-tight tracking-tight text-foreground">
      {greet}
      {display ? `, ${display}` : ""}
    </h1>
  )
}
