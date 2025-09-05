import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const API = import.meta.env.VITE_API_URL || '';

// Action codes (env-overridable)
const ADD_CODE = import.meta.env.VITE_ADD_ACTION_CODE || '##ADD##';
const REMOVE_CODE = import.meta.env.VITE_REMOVE_ACTION_CODE || '##REMOVE##';
const SEARCH_CODE = import.meta.env.VITE_SEARCH_ACTION_CODE || '##SEARCH##';

// --- Mobile helper ---
function useIsMobile(breakpoint = 768) {
  const [isM, setIsM] = React.useState(
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  );
  React.useEffect(() => {
    const onResize = () => setIsM(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isM;
}

type Item = {
  id: string;
  InventoryDate: string;
  ScannedCode: string;
  Brand: string | null;
  Model: string;
  Size: string | null;
  Color: string | null;
  Notes: string | null;
  "SoldOrder#": string | null;
  PurchasedFrom: string | null;
  PaintThickness: number | null;
  Price: number | null;
  Qty: number | null;
};
type SearchHit = Item & { onHand: number };
type Mode = 'idle' | 'add' | 'remove' | 'search';

type RemoveInitiateResp =
  | { status: 'CONFIRM_REQUIRED'; item: Item; onHand: number }
  | { status: 'REGISTERED_ZERO_STOCK'; item: Item; onHand: 0 };

function displayName(item: Pick<Item, 'Brand' | 'Model'>) {
  return `${(item.Brand ?? '').trim()} ${item.Model}`.trim();
}

// Filterable columns (string fields)
const FILTERABLE: { key: keyof Item; label: string; queryKey: string }[] = [
  { key: 'Brand',         label: 'Brand',         queryKey: 'brand' },
  { key: 'Model',         label: 'Model',         queryKey: 'model' },
  { key: 'Size',          label: 'Size',          queryKey: 'size' },
  { key: 'Color',         label: 'Color',         queryKey: 'color' },
  { key: 'PurchasedFrom', label: 'PurchasedFrom', queryKey: 'purchasedfrom' },
  { key: 'ScannedCode',   label: 'ScannedCode',   queryKey: 'scannedcode' },
  { key: 'Notes',         label: 'Notes',         queryKey: 'notes' },
  { key: 'SoldOrder#',    label: 'SoldOrder#',    queryKey: 'soldorder' },
];

export default function App() {
  const isMobile = useIsMobile();

  const [mode, setMode] = useState<Mode>('idle');
  const [toast, setToast] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [pendingItem, setPendingItem] = useState<{ code: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ item: Item; onHand: number } | null>(null);

  // Search state
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searchSummary, setSearchSummary] = useState('');
  const [filters, setFilters] = useState<Record<string, Set<string>>>(() => ({}));
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [distinct, setDistinct] = useState<Record<string, { value: string; count: number }[]>>({});

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, [mode, pendingItem, confirmRemove]);

  const makeQueryString = (term: string, f: Record<string, Set<string>> = filters) => {
    const p = new URLSearchParams();
    if (term) p.set('q', term);
    for (const { queryKey } of FILTERABLE) {
      const sel = f[queryKey];
      if (sel && sel.size) p.set(queryKey, Array.from(sel).join(','));
    }
    return p.toString();
  };

  async function runSearch(term: string, f?: Record<string, Set<string>>) {
    const qs = makeQueryString(term, f ?? filters);
    const res = await fetch(`${API}/items/search${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error('Search failed');
    const data: SearchHit[] = await res.json();
    setResults(data);
    setSearchSummary(`Results ${term ? `for "${term}"` : ''} — ${data.length} item(s)`);
  }

  async function ensureDistinct(queryKey: string) {
    if (distinct[queryKey]) return;
    const res = await fetch(`${API}/items/distinct?field=${encodeURIComponent(queryKey)}`);
    if (!res.ok) return;
    const vals = await res.json();
    setDistinct(prev => ({ ...prev, [queryKey]: vals }));
  }

  // Auto-load all items when entering Search mode
  useEffect(() => {
    if (mode === 'search') runSearch('').catch(err => console.error(err));
  }, [mode]); // eslint-disable-line

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = scanInput.trim();
    if (!code) return;

    // Action codes
    if (code === ADD_CODE)    { setMode('add');    setToast('Add mode enabled.');    setScanInput(''); setResults([]); setSearchSummary(''); return; }
    if (code === REMOVE_CODE) { setMode('remove'); setToast('Remove mode enabled.'); setScanInput(''); setResults([]); setSearchSummary(''); return; }
    if (code === SEARCH_CODE) { setMode('search'); setToast('Search mode enabled.'); setScanInput(''); setResults([]); setSearchSummary(''); setSearchTerm(''); return; }

    if (mode === 'idle') {
      setToast(`No mode selected. Scan ${ADD_CODE}, ${REMOVE_CODE}, or ${SEARCH_CODE} first.`);
      setScanInput('');
      return;
    }

    try {
      if (mode === 'search') {
        setSearchTerm(code);
        await runSearch(code);
        setToast('');
        setScanInput('');
        return;
      }

      // Lookup by ScannedCode
      const getRes = await fetch(`${API}/items/${encodeURIComponent(code)}`);
      if (getRes.status === 404) {
        setPendingItem({ code });
        setToast('Unknown item. Please create it.');
        setScanInput('');
        return;
      }
      if (!getRes.ok) throw new Error('Lookup failed');
      const item: Item = await getRes.json();

      if (mode === 'add') {
        const addRes = await fetch(`${API}/inventory/add`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ barcode: item.ScannedCode })
        });
        if (!addRes.ok) throw new Error('Add failed');
        setToast(`Added: ${displayName(item)}`);
        setScanInput('');
        return;
      }

      if (mode === 'remove') {
        const initRes = await fetch(`${API}/inventory/remove/initiate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ barcode: item.ScannedCode })
        });
        if (!initRes.ok) throw new Error('Remove initiate failed');
        const data: RemoveInitiateResp = await initRes.json();
        if (data.status === 'CONFIRM_REQUIRED') {
          setConfirmRemove({ item: data.item, onHand: data.onHand });
          setToast('Confirm removal');
        } else {
          setToast(`${displayName(data.item)} is not in stock (registered at 0).`);
          setScanInput('');
        }
        return;
      }
    } catch (err) {
      console.error(err);
      setToast('Error processing');
    }
  }

  // Filter handlers (use NEXT filters state to avoid stale updates)
  const toggleFilter = (queryKey: string, value: string) => {
    setFilters(prev => {
      const s = new Set(prev[queryKey] ?? []);
      if (s.has(value)) s.delete(value); else s.add(value);
      const next = { ...prev, [queryKey]: s };
      runSearch(searchTerm, next).catch(console.error);
      return next;
    });
  };

  const clearFilter = (queryKey: string) => {
    setFilters(prev => {
      const next = { ...prev, [queryKey]: new Set<string>() };
      runSearch(searchTerm, next).catch(console.error);
      return next;
    });
  };

  const clearAllFilters = () => {
    setFilters(() => {
      const next = {} as Record<string, Set<string>>;
      runSearch(searchTerm, next).catch(console.error);
      return next;
    });
  };

  // Mobile helper to open a filter menu
  const openFilterMenu = async (qk: string) => {
    await ensureDistinct(qk);
    setOpenMenu(qk);
  };

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      padding: isMobile ? 12 : 24,
      maxWidth: isMobile ? '100%' : 1100,
      margin: '0 auto'
    }}>
      <h1 style={{ marginTop: 0 }}>Inventory — Scan & Search</h1>
      <p>
        Mode: <strong>{mode}</strong>
        &nbsp;|&nbsp; Codes: <code>{ADD_CODE}</code> add, <code>{REMOVE_CODE}</code> remove, <code>{SEARCH_CODE}</code> search
      </p>
      {toast && <p>{toast}</p>}

      <form onSubmit={handleSubmit} style={{
        display: 'grid', gap: 10, border: '1px solid #e5e7eb', padding: 12, borderRadius: 12
      }}>
        <label>Scan / enter (action or product/search text)
          <input
            ref={inputRef}
            value={scanInput}
            onChange={e => setScanInput(e.target.value)}
            placeholder={`Scan ${ADD_CODE}, ${REMOVE_CODE}, or ${SEARCH_CODE}; then scan/enter code or search term`}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            style={{ minHeight: 44, padding: '10px 12px', fontSize: 16, width: '100%' }}
          />
        </label>
        <button type="submit" disabled={!!pendingItem || !!confirmRemove}
          style={{ minHeight: 44, padding: '10px 14px' }}>
          Submit
        </button>
      </form>

      {/* SEARCH UI */}
      {mode === 'search' && (
        <section style={{ marginTop: 16 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            gap: 8, flexWrap: 'wrap', marginBottom: 8
          }}>
            <h3 style={{ margin: 0 }}>{searchSummary || 'All items'}</h3>
            <button onClick={clearAllFilters}
              style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', minHeight: 44 }}>
              Clear all filters
            </button>
          </div>

          {/* Mobile: FILTER BAR + card list */}
          {isMobile ? (
            <>
              <MobileFilterBar
                filters={filters}
                openMenu={openMenu}
                setOpenMenu={(qk, open) => setOpenMenu(open ? qk : null)}
                distinct={distinct}
                openFilterMenu={openFilterMenu}
                toggleFilter={toggleFilter}
                clearFilter={clearFilter}
              />
              <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                {results.length === 0 ? (
                  <div style={{ padding: 12, textAlign: 'center', opacity: .7 }}>No results.</div>
                ) : results.map(r => (
                  <div key={r.id} style={{
                    border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: 700, lineHeight: 1.2 }}>
                        {displayName(r)}
                      </div>
                      <div style={{
                        fontWeight: 700, padding: '4px 8px', border: '1px solid #e5e7eb',
                        borderRadius: 999, minWidth: 54, textAlign: 'center'
                      }}>
                        {r.onHand}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, opacity: .8, marginTop: 6 }}>
                      Code: <code>{r.ScannedCode}</code>
                      {r.Color ? ` · ${r.Color}` : ''}{r.Size ? ` · ${r.Size}` : ''}
                    </div>
                    {(r.Price ?? r.Qty ?? r['SoldOrder#'] ?? r.PurchasedFrom) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, fontSize: 13 }}>
                        {r.Price != null && <span style={chip}>Price: {r.Price}</span>}
                        {r.Qty != null && <span style={chip}>Qty: {r.Qty}</span>}
                        {r['SoldOrder#'] && <span style={chip}>Order#: {r['SoldOrder#']}</span>}
                        {r.PurchasedFrom && <span style={chip}>From: {r.PurchasedFrom}</span>}
                      </div>
                    )}
                    {r.Notes && <div style={{ marginTop: 8, fontSize: 13 }}>{r.Notes}</div>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            // Desktop: table with sticky head + header filters
            <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: '#f9fafb', position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr>
                    {FILTERABLE.map(col => (
                      <ThFilter
                        key={col.queryKey}
                        label={col.label}
                        queryKey={col.queryKey}
                        selected={filters[col.queryKey]}
                        openMenu={openMenu}
                        setOpenMenu={async (qk, open) => {
                          if (open) await ensureDistinct(qk);
                          setOpenMenu(open ? qk : null);
                        }}
                        options={distinct[col.queryKey] || []}
                        onToggle={(v) => toggleFilter(col.queryKey, v)}
                        onClear={() => clearFilter(col.queryKey)}
                        isMobile={false}
                      />
                    ))}
                    <th style={thStyle}>Price</th>
                    <th style={thStyle}>Qty</th>
                    <th style={thStyle}>On-hand</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 ? (
                    <tr><td colSpan={FILTERABLE.length + 3} style={{ padding: 12, textAlign: 'center', opacity: .7 }}>No results.</td></tr>
                  ) : results.map(r => (
                    <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                      {FILTERABLE.map(col => (
                        <td key={col.queryKey} style={tdStyle}>{String((r as any)[col.key] ?? '')}</td>
                      ))}
                      <td style={tdStyle}>{r.Price ?? ''}</td>
                      <td style={tdStyle}>{r.Qty ?? ''}</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{r.onHand}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Create modal (for unknown scans in add/remove) */}
      {pendingItem && (
        <NewItemModal
          initialCode={pendingItem.code}
          onClose={() => setPendingItem(null)}
          onCreated={async (item) => {
            setPendingItem(null);
            try {
              if (mode === 'add') {
                const addRes = await fetch(`${API}/inventory/add`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ barcode: item.ScannedCode })
                });
                if (!addRes.ok) throw new Error('Add failed');
                setToast(`Item created and added: ${displayName(item)}`);
                setScanInput('');
              } else if (mode === 'remove') {
                setToast(`Item created and registered with quantity 0: ${displayName(item)}`);
                setScanInput('');
              }
            } catch (e) {
              console.error(e); setToast('Post-create action failed');
            }
          }}
        />
      )}

      {/* Remove confirmation */}
      {confirmRemove && (
        <ConfirmRemoveModal
          item={confirmRemove.item}
          onHand={confirmRemove.onHand}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={async (extra) => {
            try {
              const res = await fetch(`${API}/inventory/remove/confirm`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  barcode: confirmRemove.item.ScannedCode,
                  ...extra
                })
              });
              if (!res.ok) {
                const t = await res.json().catch(() => ({}));
                if ((t as any)?.error === 'OUT_OF_STOCK') setToast('Already out of stock.');
                else setToast('Failed to remove');
              } else {
                const data = await res.json();
                setToast(`Removed 1: ${displayName(confirmRemove.item)}. New on-hand: ${data.onHand}`);
              }
            } catch (e) {
              console.error(e); setToast('Remove failed');
            } finally {
              setConfirmRemove(null); setScanInput('');
            }
          }}
        />
      )}
    </div>
  );
}

/* =======================
   Mobile Filter Bar
   ======================= */

function MobileFilterBar({
  filters,
  openMenu,
  setOpenMenu,
  distinct,
  openFilterMenu,
  toggleFilter,
  clearFilter
}: {
  filters: Record<string, Set<string>>;
  openMenu: string | null;
  setOpenMenu: (qk: string, open: boolean) => void;
  distinct: Record<string, { value: string; count: number }[]>;
  openFilterMenu: (qk: string) => void;
  toggleFilter: (qk: string, val: string) => void;
  clearFilter: (qk: string) => void;
}) {
  return (
    <div style={{
      display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: 8,
      WebkitOverflowScrolling: 'touch'
    }}>
      {FILTERABLE.map(col => (
        <MobileFilterButton
          key={col.queryKey}
          label={col.label}
          queryKey={col.queryKey}
          selected={filters[col.queryKey]}
          isOpen={openMenu === col.queryKey}
          open={() => openFilterMenu(col.queryKey)}
          close={() => setOpenMenu(col.queryKey, false)}
          options={distinct[col.queryKey] || []}
          toggle={(val) => toggleFilter(col.queryKey, val)}
          clear={() => clearFilter(col.queryKey)}
        />
      ))}
    </div>
  );
}

function MobileFilterButton({
  label, queryKey, selected, isOpen, open, close, options, toggle, clear
}: {
  label: string;
  queryKey: string;
  selected?: Set<string>;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  options: { value: string; count: number }[];
  toggle: (val: string) => void;
  clear: () => void;
}) {
  const selCount = selected?.size ?? 0;
  return (
    <>
      <button
        type="button"
        onClick={open}
        style={{
          border: '1px solid #d1d5db', borderRadius: 999, padding: '10px 12px',
          background: '#fff', minHeight: 44, whiteSpace: 'nowrap'
        }}
        title={selCount ? `${selCount} selected` : 'Filter'}
      >
        {label}{selCount ? ` (${selCount})` : ''}
      </button>

      {isOpen && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.2)' }}
          onMouseDown={close}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed', left: 8, right: 8, bottom: 8,
              maxHeight: '70vh', background: '#fff', border: '1px solid #e5e7eb',
              borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,.2)',
              padding: 10, overflow: 'auto'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>{label}</strong>
              <button
                type="button"
                onClick={() => { clear(); close(); }}
                style={{ border: 'none', background: 'transparent', color: '#2563eb', cursor: 'pointer', padding: 8, minHeight: 44 }}
              >
                Clear
              </button>
            </div>
            {options.length === 0 ? (
              <div style={{ padding: 8, opacity: .7 }}>No values.</div>
            ) : options.map(opt => {
              const id = `${queryKey}::${opt.value}`;
              const checked = selected?.has(opt.value) ?? false;
              return (
                <label key={id} htmlFor={id}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '10px 6px', cursor: 'pointer' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input id={id} type="checkbox" checked={checked} onChange={() => toggle(opt.value)} />
                    <span>{opt.value}</span>
                  </span>
                  <span style={{ opacity: .6 }}>{opt.count}</span>
                </label>
              );
            })}
            <div style={{ textAlign: 'right', marginTop: 6 }}>
              <button
                type="button"
                onClick={close}
                style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', background: '#fff', minHeight: 44 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/* =======================
   Desktop ThFilter
   ======================= */

const thStyle: React.CSSProperties = { textAlign: 'left', padding: 10, position: 'relative', whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: 10, verticalAlign: 'top' };
const chip: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 999, padding: '2px 8px', background: '#f8fafc'
};

function ThFilter({
  label, queryKey, selected, openMenu, setOpenMenu, options, onToggle, onClear, isMobile
}: {
  label: string;
  queryKey: string;
  selected?: Set<string>;
  openMenu: string | null;
  setOpenMenu: (qk: string, open: boolean) => void;
  options: { value: string; count: number }[];
  onToggle: (val: string) => void;
  onClear: () => void;
  isMobile: boolean;
}) {
  const isOpen = openMenu === queryKey;
  const selCount = selected?.size ?? 0;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; height: number; width: number }>({
    top: 0, left: 0, height: 300, width: 260
  });

  const computePos = () => {
    if (isMobile) return;
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = 260;
    const maxHeight = Math.min(340, window.innerHeight - 16);
    let left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    let top = r.bottom + 6;
    if (top + maxHeight > window.innerHeight) top = Math.max(8, r.top - maxHeight - 6);
    setPos({ top, left, height: maxHeight, width });
  };

  useEffect(() => {
    if (!isOpen) return;
    computePos();
    const onScroll = () => computePos();
    const onResize = () => computePos();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(queryKey, false); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, isMobile, queryKey, setOpenMenu]);

  const buttonStyle: React.CSSProperties = {
    border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 10px',
    background: '#fff', cursor: 'pointer', minHeight: 44
  };

  return (
    <th style={thStyle}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpenMenu(queryKey, !isOpen)}
        style={buttonStyle}
        title={selCount ? `${selCount} selected` : 'Filter'}
      >
        {label}{selCount ? ` (${selCount})` : ''}
      </button>

      {isOpen && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'transparent' }}
          onMouseDown={() => setOpenMenu(queryKey, false)}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top, left: pos.left,
              width: pos.width, maxHeight: pos.height,
              overflow: 'auto', background: '#fff',
              border: '1px solid #e5e7eb', borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 8
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>{label}</strong>
              <button type="button" onClick={onClear}
                style={{ border: 'none', background: 'transparent', color: '#2563eb', cursor: 'pointer', padding: 8, minHeight: 44 }}>
                Clear
              </button>
            </div>
            {options.length === 0 ? (
              <div style={{ padding: 8, opacity: .7 }}>No values.</div>
            ) : options.map(opt => {
              const id = `${queryKey}::${opt.value}`;
              const checked = selected?.has(opt.value) ?? false;
              return (
                <label key={id} htmlFor={id}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '10px 6px', cursor: 'pointer' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input id={id} type="checkbox" checked={checked} onChange={() => onToggle(opt.value)} />
                    <span>{opt.value}</span>
                  </span>
                  <span style={{ opacity: .6 }}>{opt.count}</span>
                </label>
              );
            })}
            <div style={{ textAlign: 'right', marginTop: 6 }}>
              <button
                type="button"
                onClick={() => setOpenMenu(queryKey, false)}
                style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', background: '#fff', minHeight: 44 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </th>
  );
}

/* =======================
   Modals
   ======================= */

function NewItemModal(
  { initialCode, onClose, onCreated }:
  { initialCode: string; onClose: () => void; onCreated: (item: Item) => void }
) {
  const [InventoryDate, setInventoryDate] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const [ScannedCode, setScannedCode] = useState(initialCode);
  const [Brand, setBrand] = useState('');
  const [Model, setModel] = useState('');
  const [Size, setSize] = useState('');
  const [Color, setColor] = useState('');
  const [Notes, setNotes] = useState('');
  const [SoldOrder, setSoldOrder] = useState('');
  const [PurchasedFrom, setPurchasedFrom] = useState('');
  const [PaintThickness, setPaintThickness] = useState('');
  const [Price, setPrice] = useState('');
  const [Qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const invISO = new Date(InventoryDate).toISOString();
      const payload: any = {
        InventoryDate: invISO,
        ScannedCode: ScannedCode.trim(),
        Brand: Brand || null,
        Model: Model.trim(),
        Size: Size || null,
        Color: Color || null,
        Notes: Notes || null,
        ["SoldOrder#"]: SoldOrder || null,
        PurchasedFrom: PurchasedFrom || null,
        PaintThickness: PaintThickness !== '' ? Number(PaintThickness) : null,
        Price: Price !== '' ? Number(Price) : null,
        Qty: Qty !== '' ? Number(Qty) : null
      };
      const res = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Create failed');
      const item: Item = await res.json();
      onCreated(item);
    } catch (e) { console.error(e); alert('Failed to create item'); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center' }}>
      <form onSubmit={submit} style={{ background: '#fff', padding: 16, borderRadius: 12, minWidth: 420, display: 'grid', gap: 8 }}>
        <h3>New Item</h3>
        <label>InventoryDate
          <input type="datetime-local" value={InventoryDate} onChange={e => setInventoryDate(e.target.value)} required />
        </label>
        <label>ScannedCode
          <input value={ScannedCode} onChange={e => setScannedCode(e.target.value)} required />
        </label>
        <label>Brand
          <input value={Brand} onChange={e => setBrand(e.target.value)} />
        </label>
        <label>Model
          <input value={Model} onChange={e => setModel(e.target.value)} required />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>Size
            <input value={Size} onChange={e => setSize(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>Color
            <input value={Color} onChange={e => setColor(e.target.value)} />
          </label>
        </div>
        <label>Notes
          <input value={Notes} onChange={e => setNotes(e.target.value)} />
        </label>
        <label>SoldOrder#
          <input value={SoldOrder} onChange={e => setSoldOrder(e.target.value)} />
        </label>
        <label>PurchasedFrom
          <input value={PurchasedFrom} onChange={e => setPurchasedFrom(e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>PaintThickness
            <input type="number" step="0.01" value={PaintThickness} onChange={e => setPaintThickness(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>Price
            <input type="number" step="0.01" value={Price} onChange={e => setPrice(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>Qty
            <input type="number" step="1" value={Qty} onChange={e => setQty(e.target.value)} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmRemoveModal(
  { item, onHand, onCancel, onConfirm }:
  {
    item: Item; onHand: number; onCancel: () => void; onConfirm: (payload: {
      ["Order Id"]?: string | null;
      ["Where bought from"]?: string | null;
      ["Date Subtracted"]?: string | null;
    }) => void
  }
) {
  const [orderId, setOrderId] = React.useState('');
  const [whereBought, setWhereBought] = React.useState('');
  const [dateSub, setDateSub] = React.useState(() => {
    const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center' }}>
      <div style={{ background: '#fff', padding: 16, borderRadius: 12, minWidth: 420 }}>
        <h3>Confirm Removal</h3>
        <p><strong>{displayName(item)}</strong></p>
        <p>ScannedCode: <code>{item.ScannedCode}</code></p>
        <p>In stock: <strong>{onHand}</strong></p>

        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <label>Order Id
            <input value={orderId} onChange={e => setOrderId(e.target.value)} placeholder="e.g. SO-12345" />
          </label>
          <label>Where bought from
            <input value={whereBought} onChange={e => setWhereBought(e.target.value)} placeholder="e.g. Website / Store" />
          </label>
          <label>Date Subtracted
            <input type="datetime-local" value={dateSub} onChange={e => setDateSub(e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onCancel}>No</button>
          <button
            type="button"
            onClick={() => onConfirm({
              ["Order Id"]: orderId || null,
              ["Where bought from"]: whereBought || null,
              ["Date Subtracted"]: dateSub ? new Date(dateSub).toISOString() : null
            })}
          >
            Yes, remove 1
          </button>
        </div>
      </div>
    </div>
  );
}
