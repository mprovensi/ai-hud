import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Lock,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, ModalFrame, ToolIcon } from '../ui';
import type { McpServerItem, McpStatusResponse, McpTarget, McpTargetState, Snapshot } from '../types';

interface Props {
  snap: Snapshot | null;
  onNotify: (msg: string, err?: boolean) => void;
}

const TARGET_META: { id: McpTarget; label: string; toolName: string }[] = [
  { id: 'claude', label: 'Claude Code', toolName: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI', toolName: 'Codex' },
  { id: 'antigravity', label: 'Antigravity', toolName: 'Gemini' },
];

function stateBadge(state?: McpTargetState): { label: string; color: string } {
  if (state === 'synced') return { label: 'sincronizado', color: 'var(--ds-ok, #5ea87e)' };
  if (state === 'outdated') return { label: 'desatualizado', color: 'var(--ds-warn, #d9a441)' };
  if (state === 'missing') return { label: 'pendente', color: 'var(--ds-warn, #d9a441)' };
  if (state === 'stale') return { label: 'remover', color: 'var(--ds-danger, #d95b5b)' };
  return { label: 'off', color: 'var(--ds-muted)' };
}

interface DraftForm {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  url: string;
  envText: string;
  headersText: string;
  enabled: boolean;
  targets: Record<McpTarget, boolean>;
  machinesText: string;
  isEdit: boolean;
}

function emptyDraft(): DraftForm {
  return {
    id: '',
    name: '',
    description: '',
    transport: 'stdio',
    command: 'npx',
    argsText: '',
    url: '',
    envText: '',
    headersText: '',
    enabled: true,
    targets: { claude: true, codex: true, antigravity: true },
    machinesText: '',
    isEdit: false,
  };
}

function serverToDraft(s: McpServerItem): DraftForm {
  const fmtMap = (m?: Record<string, string>) =>
    Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  return {
    id: s.id,
    name: s.name || s.id,
    description: s.description || '',
    transport: s.transport || 'stdio',
    command: s.command || '',
    argsText: (s.args || []).join('\n'),
    url: s.url || '',
    envText: fmtMap(s.env),
    headersText: fmtMap(s.headers),
    enabled: s.enabled !== false,
    targets: {
      claude: s.targets?.claude !== false,
      codex: s.targets?.codex !== false,
      antigravity: s.targets?.antigravity !== false,
    },
    machinesText: (s.machines || []).join(', '),
    isEdit: true,
  };
}

function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function McpPane({ snap, onNotify }: Props) {
  const [machine, setMachine] = useState('');
  const [status, setStatus] = useState<McpStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<DraftForm | null>(null);

  const machines = (snap?.machines || []).filter((m) => m.ok).map((m) => m.name);

  const load = useCallback(async (targetMachine = machine) => {
    setLoading(true);
    try {
      const r = await api.getMcpStatus(targetMachine);
      setStatus(r);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [machine, onNotify]);

  useEffect(() => {
    load(machine);
  }, [machine, load]);

  async function handleImport() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.importMcpFromClis({ machine });
      setStatus(r.status);
      onNotify(
        r.importedCount > 0
          ? `${r.importedCount} MCP(s) importado(s) para o catálogo compartilhado (segredos isolados localmente).`
          : 'Nenhum MCP novo encontrado nas CLIs desta máquina.',
      );
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleInstallMemory() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.installMcpMemoryPreset({ machine, sync: true });
      setStatus(r.status);
      onNotify('MCP ai-hud-memory instalado e sincronizado nas 3 CLIs!');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSync(targets?: McpTarget[]) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.syncMcpToClis({ machine, targets });
      setStatus(r.status);
      onNotify('MCPs sincronizados nas CLIs com backup automático.');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function toggleServerTarget(srv: McpServerItem, target: McpTarget) {
    if (busy) return;
    setBusy(true);
    try {
      const next = { ...srv, targets: { ...srv.targets, [target]: !srv.targets[target] } };
      const r = await api.saveMcpServer({ machine, server: next });
      setStatus(r.status);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function toggleServerEnabled(srv: McpServerItem) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.saveMcpServer({ machine, server: { ...srv, enabled: !srv.enabled } });
      setStatus(r.status);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(srv: McpServerItem) {
    if (busy || !window.confirm(`Remover "${srv.name}" do catálogo compartilhado? (Clique em Sincronizar depois para remover das CLIs.)`)) return;
    setBusy(true);
    try {
      const r = await api.deleteMcpServer({ machine, id: srv.id });
      setStatus(r.status);
      onNotify(`MCP "${srv.name}" removido do catálogo.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveModal() {
    if (!modal || busy) return;
    setBusy(true);
    try {
      const args = modal.argsText
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      const env = parseKvLines(modal.envText);
      const headers = parseKvLines(modal.headersText);
      const machinesList = modal.machinesText
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

      const r = await api.saveMcpServer({
        machine,
        server: {
          id: modal.id.trim() || modal.name.trim(),
          name: modal.name.trim() || modal.id.trim(),
          description: modal.description.trim(),
          transport: modal.transport,
          command: modal.transport === 'stdio' ? modal.command.trim() : '',
          args: modal.transport === 'stdio' ? args : [],
          url: modal.transport === 'http' ? modal.url.trim() : '',
          env,
          headers,
          enabled: modal.enabled,
          targets: modal.targets,
          machines: machinesList,
        },
      });
      setStatus(r.status);
      setModal(null);
      onNotify(`MCP "${r.server.name}" salvo. Clique em Sincronizar para aplicar nas CLIs.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const pendingSyncCount = (status?.servers || []).filter((s) =>
    TARGET_META.some((t) => {
      const st = s.targetStatus?.[t.id];
      return st === 'missing' || st === 'outdated' || st === 'stale';
    }),
  ).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Barra de ações */}
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plug size={15} color="var(--accent)" />
          <strong>Catálogo MCP</strong>
          {machines.length > 0 && (
            <select
              className="sel"
              style={{ width: 'auto', minWidth: 140, padding: '4px 8px', fontSize: 12 }}
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
            >
              <option value="">Esta máquina ({status?.machine || 'local'})</option>
              {machines.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Button size="sm" disabled={busy} onClick={handleImport} title="Importar MCPs já configurados em Claude, Codex e Antigravity">
            <Download size={13} /> Importar das CLIs
          </Button>
          <Button size="sm" disabled={busy} onClick={handleInstallMemory} title="Configurar ai-hud-memory nas 3 CLIs em 1 clique">
            <Sparkles size={13} /> Preset ai-hud-memory
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setModal(emptyDraft())}>
            <Plus size={13} /> Novo MCP
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => handleSync()}
            title="Aplicar catálogo em ~/.claude.json, ~/.codex/config.toml e ~/.gemini/antigravity/mcp_config.json"
          >
            <RefreshCw size={13} /> Sincronizar CLIs{pendingSyncCount > 0 ? ` (${pendingSyncCount})` : ''}
          </Button>
        </div>
      </div>

      {/* Status das 3 CLIs na máquina selecionada */}
      {status && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
          {TARGET_META.map((t) => {
            const exists = status.cliExists?.[t.id];
            const syncedCount = status.servers.filter((s) => s.targetStatus?.[t.id] === 'synced').length;
            const pendingCount = status.servers.filter((s) => ['missing', 'outdated', 'stale'].includes(s.targetStatus?.[t.id] || '')).length;
            return (
              <div
                key={t.id}
                className="split-pane"
                style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <ToolIcon tool={t.toolName} size={14} />
                  <strong style={{ fontSize: 13 }}>{t.label}</strong>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: exists ? 'var(--ds-ok, #5ea87e)' : 'var(--muted)' }}>
                    {exists ? 'detectado' : 'não criado'}
                  </span>
                </div>
                <div className="mono ell" style={{ fontSize: 10.5, color: 'var(--muted)' }} title={status.cliPaths?.[t.id]}>
                  {status.cliPaths?.[t.id]}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                  <Badge>{syncedCount} ativo(s)</Badge>
                  {pendingCount > 0 && <Badge tone="waiting">{pendingCount} pendente(s)</Badge>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lista de MCPs gerenciados */}
      {loading ? (
        <div className="empty">Carregando catálogo MCP…</div>
      ) : !status || status.servers.length === 0 ? (
        <div className="split-pane empty" style={{ minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <div>Nenhum servidor MCP no catálogo compartilhado ainda.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={busy} onClick={handleImport}>
              <Download size={13} /> Importar das CLIs instaladas
            </Button>
            <Button size="sm" disabled={busy} onClick={handleInstallMemory}>
              <Sparkles size={13} /> Instalar ai-hud-memory
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {status.servers.map((srv) => (
            <div
              key={srv.id}
              className="split-pane"
              style={{
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                opacity: srv.enabled ? 1 : 0.62,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Plug size={14} color={srv.enabled ? 'var(--accent)' : 'var(--muted)'} />
                <strong style={{ fontSize: 13.5 }}>{srv.name}</strong>
                <span className="badge mono">{srv.id}</span>
                <span className="badge">{srv.transport.toUpperCase()}</span>
                {srv.secretKeys && srv.secretKeys.length > 0 && (
                  <span
                    className={`badge ${srv.missingSecrets && srv.missingSecrets.length ? 'waiting' : ''}`}
                    title={
                      srv.missingSecrets && srv.missingSecrets.length
                        ? `Faltam segredos locais nesta máquina: ${srv.missingSecrets.join(', ')}`
                        : `Segredos armazenados localmente em data/mcp-secrets.json: ${srv.secretKeys.join(', ')}`
                    }
                  >
                    <Lock size={11} />{' '}
                    {srv.missingSecrets && srv.missingSecrets.length
                      ? `${srv.missingSecrets.length} segredo(s) pendente(s)`
                      : `${srv.secretKeys.length} segredo(s) locais`}
                  </span>
                )}
                {srv.machines && srv.machines.length > 0 && (
                  <span className="badge">máquinas: {srv.machines.join(', ')}</span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <Button size="sm" disabled={busy} onClick={() => toggleServerEnabled(srv)}>
                    {srv.enabled ? 'Ativo' : 'Pausado'}
                  </Button>
                  <Button size="sm" iconOnly title="Editar MCP" disabled={busy} onClick={() => setModal(serverToDraft(srv))}>
                    <Pencil size={12} />
                  </Button>
                  <Button size="sm" iconOnly variant="danger" title="Remover MCP" disabled={busy} onClick={() => handleDelete(srv)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>

              {srv.description && (
                <div style={{ fontSize: 12, color: 'var(--ds-text-soft)' }}>{srv.description}</div>
              )}

              <div className="mono ell" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {srv.transport === 'http'
                  ? srv.url
                  : `${srv.command} ${(srv.args || []).join(' ')}`.trim()}
              </div>

              {/* Toggles por CLI */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 2 }}>
                {TARGET_META.map((t) => {
                  const on = !!srv.targets?.[t.id];
                  const st = stateBadge(srv.targetStatus?.[t.id]);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleServerTarget(srv, t.id)}
                      className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                      style={{ gap: 6, fontSize: 11.5 }}
                      title={`Alternar ${srv.name} no ${t.label} (status atual: ${st.label})`}
                    >
                      <ToolIcon tool={t.toolName} size={12} />
                      <span>{t.label}</span>
                      <span style={{ fontSize: 10.5, opacity: 0.9, color: on ? 'inherit' : st.color }}>
                        · {st.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MCPs detectados fora do catálogo */}
      {status && status.unmanaged.length > 0 && (
        <div className="split-pane" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong style={{ fontSize: 12.5 }}>Detectados nas CLIs fora do catálogo ({status.unmanaged.length})</strong>
            <Button size="sm" disabled={busy} onClick={handleImport}>
              <Download size={12} /> Importar para compartilhar
            </Button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {status.unmanaged.map((u) => (
              <span key={u.id} className="badge mono" style={{ fontSize: 11 }}>
                {u.id} ({u.foundIn.join(', ')})
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <CheckCircle2 size={13} color="var(--ds-ok, #5ea87e)" />
        <span>
          Catálogo portátil em <code>mcp-servers.json</code> (compatível com Git). Chaves/tokens são salvos apenas em{' '}
          <code>data/mcp-secrets.json</code> na máquina local via placeholders <code>{'${VAR}'}</code>.
        </span>
      </div>

      {/* Modal Criar / Editar MCP */}
      {modal && (
        <ModalFrame
          open={!!modal}
          title={modal.isEdit ? `Editar MCP · ${modal.id}` : 'Novo Servidor MCP Compartilhado'}
          onClose={() => setModal(null)}
          maxWidth={560}
          footer={(
            <>
              <Button size="sm" onClick={() => setModal(null)}>Cancelar</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={handleSaveModal}>
                Salvar no catálogo
              </Button>
            </>
          )}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field">
              <label>ID (slug)</label>
              <input
                className="inp mono"
                disabled={modal.isEdit}
                value={modal.id}
                onChange={(e) => setModal({ ...modal, id: e.target.value })}
                placeholder="ex.: figma, github, atlassian"
              />
            </div>
            <div className="field">
              <label>Nome</label>
              <input
                className="inp"
                value={modal.name}
                onChange={(e) => setModal({ ...modal, name: e.target.value })}
                placeholder="Nome legível"
              />
            </div>
          </div>

          <div className="field">
            <label>Descrição (opcional)</label>
            <input
              className="inp"
              value={modal.description}
              onChange={(e) => setModal({ ...modal, description: e.target.value })}
              placeholder="Para que serve este servidor MCP"
            />
          </div>

          <div className="field">
            <label>Transporte</label>
            <div className="seg">
              <button
                type="button"
                className={modal.transport === 'stdio' ? 'on' : ''}
                onClick={() => setModal({ ...modal, transport: 'stdio' })}
              >
                STDIO (processo local)
              </button>
              <button
                type="button"
                className={modal.transport === 'http' ? 'on' : ''}
                onClick={() => setModal({ ...modal, transport: 'http' })}
              >
                HTTP / Remoto
              </button>
            </div>
          </div>

          {modal.transport === 'stdio' ? (
            <>
              <div className="field">
                <label>Comando</label>
                <input
                  className="inp mono"
                  value={modal.command}
                  onChange={(e) => setModal({ ...modal, command: e.target.value })}
                  placeholder="node, npx, uvx ou caminho do executável"
                />
              </div>
              <div className="field">
                <label>Argumentos (1 por linha — suporta {'{{AI_HUD_ROOT}}'})</label>
                <textarea
                  className="ta mono"
                  rows={3}
                  value={modal.argsText}
                  onChange={(e) => setModal({ ...modal, argsText: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-github'}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>URL do servidor MCP</label>
                <input
                  className="inp mono"
                  value={modal.url}
                  onChange={(e) => setModal({ ...modal, url: e.target.value })}
                  placeholder="https://mcp.exemplo.com/mcp"
                />
              </div>
              <div className="field">
                <label>Headers (CHAVE=VALOR, 1 por linha)</label>
                <textarea
                  className="ta mono"
                  rows={2}
                  value={modal.headersText}
                  onChange={(e) => setModal({ ...modal, headersText: e.target.value })}
                  placeholder="Authorization=${MEU_TOKEN}"
                />
              </div>
            </>
          )}

          <div className="field">
            <label>Variáveis de ambiente (CHAVE=VALOR, 1 por linha — tokens/chaves viram {'${VAR}'} local)</label>
            <textarea
              className="ta mono"
              rows={3}
              value={modal.envText}
              onChange={(e) => setModal({ ...modal, envText: e.target.value })}
              placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}\nJIRA_URL=https://empresa.atlassian.net'}
            />
          </div>

          <div className="field">
            <label>CLIs destino</label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {TARGET_META.map((t) => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!modal.targets[t.id]}
                    onChange={(e) => setModal({ ...modal, targets: { ...modal.targets, [t.id]: e.target.checked } })}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Restringir a máquinas específicas (opcional, separadas por vírgula — vazio = todas)</label>
            <input
              className="inp"
              value={modal.machinesText}
              onChange={(e) => setModal({ ...modal, machinesText: e.target.value })}
              placeholder="ex.: MateusNote, PC-Desktop"
            />
          </div>
        </ModalFrame>
      )}
    </div>
  );
}
