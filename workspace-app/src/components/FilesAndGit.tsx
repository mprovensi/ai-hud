import { useEffect, useState } from 'react';
import { ChevronLeft, Code2, FileCode2, Folder, FolderPlus, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, EmptyState } from '../ui';
import type { FsEntry, GitInfo } from '../types';

interface Props {
  cwd: string;
  machine?: string;
  onNotify: (msg: string, err?: boolean) => void;
}

export function FilesAndGit({ cwd, machine = '', onNotify }: Props) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [mode, setMode] = useState<'diff' | 'content'>('diff');
  const [preview, setPreview] = useState<{ content: string; mode: string; binary?: boolean; redacted?: boolean; fallback?: string } | null>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [openingVsCode, setOpeningVsCode] = useState(false);

  async function openProjectInVsCode() {
    if (!cwd || openingVsCode) return;
    setOpeningVsCode(true);
    try {
      const r = await api.openInVsCode({ cwd, machine });
      onNotify(r.message || (r.launched ? 'VS Code aberto na pasta do projeto.' : 'VS Code não disponível nesta máquina.'), !r.launched);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setOpeningVsCode(false);
    }
  }

  async function createFolderHere() {
    const clean = newFolderName.trim();
    if (!clean || creatingFolder) return;
    const rel = dir ? `${dir}/${clean}` : clean;
    setCreatingFolder(true);
    try {
      await api.mkdir({ cwd, name: rel, machine });
      setNewFolderName('');
      setNewFolderOpen(false);
      await loadDir(dir);
      onNotify(`Pasta "${clean}" criada.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setCreatingFolder(false);
    }
  }

  async function loadDir(nextDir: string) {
    try {
      const r = await api.listFiles(cwd, nextDir, machine);
      setDir(r.dir);
      setEntries(r.entries);
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  async function loadGit() {
    try {
      const g = await api.getGit(cwd, machine);
      setGit(g);
    } catch {
      setGit(null);
    }
  }

  async function openPreview(relPath: string, nextMode: 'diff' | 'content') {
    setSelectedFile(relPath);
    setMode(nextMode);
    setLoadingPrev(true);
    try {
      const r = await api.previewFile({ cwd, path: relPath, mode: nextMode, machine });
      setPreview(r);
    } catch (e) {
      setPreview(null);
      onNotify((e as Error).message, true);
    } finally {
      setLoadingPrev(false);
    }
  }

  useEffect(() => {
    setSelectedFile('');
    setPreview(null);
    loadDir('');
    loadGit();
  }, [cwd, machine]);

  function parentDir() {
    if (!dir) return '';
    const parts = dir.split('/');
    parts.pop();
    return parts.join('/');
  }

  function renderDiff(text: string) {
    return text.split(/\r?\n/).map((line, i) => {
      let cls = '';
      if (line.startsWith('@@')) cls = 'd-hunk';
      else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'd-add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'd-del';
      return <span key={i} className={cls}>{line}{'\n'}</span>;
    });
  }

  return (
    <div>
      <div className="toolbar">
        <Badge mono>{machine ? `${machine}: ` : ''}{cwd}</Badge>
        {git?.isRepo && (
          <Badge tone="in-progress">
            <GitBranch size={12} /> {git.branch}
          </Badge>
        )}
        {git?.isRepo && (
          <Badge tone={git.modified.length ? 'waiting' : 'done'}>
            {git.modified.length ? `${git.modified.length} alterado(s)` : 'Árvore limpa'}
          </Badge>
        )}
        <div className="ds-row" style={{ marginLeft: 'auto' }}>
          <Button
            size="sm"
            disabled={openingVsCode}
            onClick={openProjectInVsCode}
            title={`Abrir ${cwd} no VS Code${machine ? ` (${machine})` : ''}`}
          >
            <Code2 size={13} /> {openingVsCode ? 'Abrindo…' : 'Abrir no VS Code'}
          </Button>
          <Button size="sm" onClick={() => { loadDir(dir); loadGit(); }}>
            <RefreshCw size={13} /> Atualizar
          </Button>
        </div>
      </div>

      {git?.isRepo && git.modified.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {git.modified.slice(0, 12).map((m) => (
            <button
              key={m.path}
              className="btn btn-sm mono"
              onClick={() => openPreview(m.path, 'diff')}
              title="Ver git diff"
            >
              <span style={{ color: 'var(--warn)' }}>{m.code}</span> {m.path}
            </button>
          ))}
        </div>
      )}

      <div className="fs-grid">
        <div className="fs-tree">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            {dir && (
              <button className="btn btn-sm btn-icon" onClick={() => loadDir(parentDir())} title="Voltar pasta">
                <ChevronLeft size={14} />
              </button>
            )}
            <span className="mono ell" style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>/{dir}</span>
            <button
              className="btn btn-sm btn-icon"
              onClick={() => setNewFolderOpen((v) => !v)}
              title="Criar nova pasta neste diretório"
              aria-label="Nova pasta"
            >
              <FolderPlus size={13} />
            </button>
          </div>
          {newFolderOpen && (
            <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
              <input
                className="inp mono"
                style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: '4px 7px' }}
                autoFocus
                value={newFolderName}
                disabled={creatingFolder}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); createFolderHere(); }
                  if (e.key === 'Escape') setNewFolderOpen(false);
                }}
                placeholder="nome-da-pasta"
              />
              <button className="btn btn-sm btn-primary" disabled={creatingFolder || !newFolderName.trim()} onClick={createFolderHere}>
                Criar
              </button>
            </div>
          )}
          {entries.map((e) => (
            <button
              key={e.path}
              className={`sb-item ${selectedFile === e.path ? 'active' : ''}`}
              onClick={() => (e.type === 'dir' ? loadDir(e.path) : openPreview(e.path, 'content'))}
            >
              {e.type === 'dir' ? <Folder size={14} color="var(--ds-warn)" /> : <FileCode2 size={14} color="var(--ds-muted)" />}
              <span className="ell">{e.name}</span>
            </button>
          ))}
          {!entries.length && <EmptyState compact>Pasta vazia</EmptyState>}

          {git?.commits && git.commits.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div className="sb-sec" style={{ paddingLeft: 2 }}>Últimos commits</div>
              {git.commits.slice(0, 6).map((c) => (
                <div key={c.hash} style={{ fontSize: 11.5, padding: '4px 2px', color: 'var(--muted)', display: 'flex', gap: 6 }}>
                  <GitCommitHorizontal size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span className="mono" style={{ color: 'var(--accent)' }}>{c.hash}</span>
                  <span className="ell" title={c.message}>{c.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="fs-viewer">
          {selectedFile ? (
            <>
              <div className="toolbar" style={{ marginBottom: 8 }}>
                <span className="mono ell" style={{ fontSize: 12.5 }}>{selectedFile}</span>
                <div className="seg" style={{ marginLeft: 'auto' }}>
                  <button className={mode === 'diff' ? 'on' : ''} onClick={() => openPreview(selectedFile, 'diff')}>Diff</button>
                  <button className={mode === 'content' ? 'on' : ''} onClick={() => openPreview(selectedFile, 'content')}>Arquivo</button>
                </div>
              </div>
              {preview?.fallback === 'no-diff' && (
                <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 6 }}>Sem diff pendente — exibindo conteúdo atual.</div>
              )}
              {preview?.redacted && (
                <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 6 }}>🔒 Segredos detectados foram ocultados automaticamente.</div>
              )}
              {loadingPrev ? (
                <div className="empty">Carregando…</div>
              ) : preview?.binary ? (
                <div className="empty">Arquivo binário — prévia indisponível.</div>
              ) : (
                <pre className="diff-pre">
                  <code>{preview ? (preview.mode === 'diff' ? renderDiff(preview.content) : preview.content) : ''}</code>
                </pre>
              )}
            </>
          ) : (
            <div className="empty">Selecione um arquivo na árvore ou um arquivo modificado no Git para inspecionar.</div>
          )}
        </div>
      </div>
    </div>
  );
}
