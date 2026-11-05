// Grok Bot routes: one card per bot, edited with fields and checkboxes instead of typed lines.
// The worker owns the data (the `routes` setting and secrets). This panel only calls it through
// plugin.request and never receives a stored Authorization value, only whether one is saved.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  env,
  Field,
  Heading,
  Input,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext,
} from 'orca'

type Route = { name: string; url: string; workspaces: string[]; hasAuth: boolean }
type State = { routes: Route[]; workspaces: string[]; errors: { line: number; reason: string }[] }
type Draft = { previousName: string | null; name: string; url: string; auth: string; workspaces: string[]; hasAuth: boolean }

const WORDS = {
  en: {
    title: 'Grok Bot routes',
    intro: 'Each bot gets the Orca alerts of the workspaces you tick. Copy the URL and the Authorization value from its routine screen.',
    empty: 'No bot yet',
    emptyHint: 'Add one to send Orca alerts to a Grok Bot routine.',
    add: 'Add bot',
    edit: 'Edit',
    newBot: 'New bot',
    name: 'Bot name',
    url: 'Grok Bot routine URL',
    auth: 'Authorization value',
    authPaste: 'Paste from the routine screen',
    authKeep: 'Saved. Leave empty to keep it',
    saved: 'Authorization saved',
    noAuth: 'No Authorization',
    workspaces: 'Workspaces',
    workspacesHint: 'None ticked sends every workspace.',
    all: 'Every workspace',
    save: 'Save',
    cancel: 'Cancel',
    remove: 'Delete',
    confirm: 'Delete this bot',
    loading: 'Loading',
    skipped: 'Lines in the Routes setting that were skipped',
  },
  ko: {
    title: 'Grok Bot 라우팅',
    intro: '봇마다 체크한 워크스페이스의 Orca 알림을 받습니다. URL과 Authorization 값은 그 봇의 루틴 화면에서 복사해 넣으세요.',
    empty: '아직 봇이 없습니다',
    emptyHint: '봇을 추가하면 Orca 알림이 그 Grok Bot 루틴으로 갑니다.',
    add: '봇 추가',
    edit: '편집',
    newBot: '새 봇',
    name: '봇 이름',
    url: 'Grok Bot routine URL',
    auth: 'Authorization value',
    authPaste: '루틴 화면에서 복사해 붙여 넣기',
    authKeep: '저장됨. 비워 두면 그대로 둡니다',
    saved: 'Authorization 저장됨',
    noAuth: 'Authorization 없음',
    workspaces: '워크스페이스',
    workspacesHint: '아무것도 체크하지 않으면 모든 워크스페이스를 보냅니다.',
    all: '모든 워크스페이스',
    save: '저장',
    cancel: '취소',
    remove: '삭제',
    confirm: '이 봇 삭제',
    loading: '불러오는 중',
    skipped: 'Routes 설정에서 건너뛴 줄',
  },
}
const t = (word: keyof typeof WORDS.en) => (env.locale.toLowerCase().startsWith('ko') ? WORDS.ko : WORDS.en)[word]

const state = atom<State | null>(null)
const draft = atom<Draft | null>(null)
const problem = atom<string | null>(null)
const busy = atom(false)
const confirming = atom(false)

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function ask(name: string, input?: unknown): Promise<void> {
  set(busy, true)
  set(problem, null)
  try {
    set(state, (await plugin.request(name, input as never)) as State)
    set(draft, null)
    set(confirming, false)
  } catch (err) {
    set(problem, message(err))
  } finally {
    set(busy, false)
  }
}

function refresh(): void {
  void plugin
    .request('routes.list')
    .then((answer) => {
      set(state, answer as State)
      // An open form keeps its own save error; otherwise the list is current again.
      if (!read(draft)) set(problem, null)
    })
    .catch((err) => set(problem, message(err)))
}

function open(route: Route | null): void {
  set(problem, null)
  set(confirming, false)
  set(draft, {
    previousName: route?.name ?? null,
    name: route?.name ?? '',
    url: route?.url ?? '',
    auth: '',
    workspaces: route?.workspaces ?? [],
    hasAuth: route?.hasAuth ?? false,
  })
}

const patch = (change: Partial<Draft>) => update(draft, (d) => (d ? { ...d, ...change } : d))

function tick(workspace: string, checked: boolean): void {
  update(draft, (d) => {
    if (!d) return d
    const rest = d.workspaces.filter((w) => !same(w, workspace))
    return { ...d, workspaces: checked ? [...rest, workspace] : rest }
  })
}

function save(): void {
  const d = read(draft)
  // The worker saves by name, so a new bot named like a listed one would replace it and inherit its Authorization.
  if (d?.previousName === null && read(state)?.routes.some((r) => same(r.name, d.name.trim()))) {
    set(problem, 'another bot already has this name')
    return
  }
  if (d) void ask('routes.save', { previousName: d.previousName, name: d.name, url: d.url, workspaces: d.workspaces, auth: d.auth })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('routes.changed', () => refresh()))
  refresh()
}

function form(d: Draft, choices: string[]) {
  // Ticked entries that no open workspace has (typed by hand, or a repo not open now) stay listed.
  const options = [...choices, ...d.workspaces.filter((w) => !choices.some((c) => same(c, w)))]
  const working = read(busy)
  return (
    <Card title={d.previousName ?? t('newBot')}>
      <Stack gap="sm">
        <Input label={t('name')} value={d.name} onChange={(name) => patch({ name })} />
        <Input label={t('url')} value={d.url} placeholder="https://..." onChange={(url) => patch({ url })} />
        <Input
          label={t('auth')}
          type="password"
          value={d.auth}
          placeholder={d.hasAuth ? t('authKeep') : t('authPaste')}
          onChange={(auth) => patch({ auth })}
        />
        <Field label={t('workspaces')} description={t('workspacesHint')}>
          <Stack gap="xs">
            {options.map((w) => (
              <Checkbox label={w} checked={d.workspaces.some((x) => same(x, w))} onChange={(checked) => tick(w, checked)} />
            ))}
          </Stack>
        </Field>
        {read(problem) ? <Callout tone="danger">{read(problem)}</Callout> : null}
        <Row gap="xs" wrap>
          <Button tone="accent" icon="check" disabled={working} onPress={save}>
            {t('save')}
          </Button>
          <Button variant="ghost" disabled={working} onPress={() => (set(draft, null), set(problem, null))}>
            {t('cancel')}
          </Button>
          {d.previousName === null ? null : read(confirming) ? (
            <Button tone="danger" icon="delete" disabled={working} onPress={() => void ask('routes.delete', { name: d.previousName })}>
              {t('confirm')}
            </Button>
          ) : (
            <Button variant="ghost" tone="danger" icon="delete" disabled={working} onPress={() => set(confirming, true)}>
              {t('remove')}
            </Button>
          )}
        </Row>
      </Stack>
    </Card>
  )
}

function card(route: Route) {
  return (
    <Card title={route.name} description={route.workspaces.length ? route.workspaces.join(', ') : t('all')}>
      <Row justify="between" align="center">
        <Badge tone={route.hasAuth ? 'success' : 'warning'}>{route.hasAuth ? t('saved') : t('noAuth')}</Badge>
        <Button variant="ghost" size="sm" icon="edit" onPress={() => open(route)}>
          {t('edit')}
        </Button>
      </Row>
    </Card>
  )
}

export default function Panel() {
  const s = read(state)
  const d = read(draft)
  return (
    <Stack gap="md">
      <Heading level={2}>{t('title')}</Heading>
      <Text muted size="sm">
        {t('intro')}
      </Text>
      {s === null && !read(problem) ? <Spinner label={t('loading')} /> : null}
      {read(problem) && !d ? <Callout tone="danger">{read(problem)}</Callout> : null}
      {s && s.errors.length > 0 ? (
        <Callout tone="warning" title={t('skipped')}>
          {s.errors.map((e) => `#${e.line}: ${e.reason}`).join(' · ')}
        </Callout>
      ) : null}
      {s && s.routes.length === 0 && !d ? <EmptyState icon="bot" title={t('empty')} description={t('emptyHint')} /> : null}
      {s ? s.routes.map((route) => (d && d.previousName !== null && same(d.previousName, route.name) ? form(d, s.workspaces) : card(route))) : null}
      {/* A new bot, or one removed elsewhere while it was being edited: the form stays, with Cancel. */}
      {s && d && !s.routes.some((r) => d.previousName !== null && same(d.previousName, r.name)) ? form(d, s.workspaces) : null}
      {s && !d ? (
        <Button icon="add" onPress={() => open(null)}>
          {t('add')}
        </Button>
      ) : null}
    </Stack>
  )
}
