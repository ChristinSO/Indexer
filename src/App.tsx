import { useCallback, useEffect, useRef, useState, type FormEvent, type DragEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Search, Upload, Plus, Image as ImageIcon, Star, Clock3, Settings, HardDrive, X, Check, ChevronLeft, ChevronRight, Info, Trash2, ArrowLeft, Menu, LoaderCircle, Pause, Play, RotateCcw, Download, ShieldCheck, AlertCircle, ArrowUpRight, Sparkles } from 'lucide-react'
import { api, connect, type Photo, type Status, type SearchResult, type SearchScope } from './api'
import { Button } from './components/ui/button'
import { SearchModes } from './components/search-modes'
import { DEFAULT_CUTOFF, matchPercent, searchHits, type SearchMode } from './search'

const bytes = (value: number) => value === 0 ? '0 MB' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, value / 1024 ** 2).toFixed(1)} MB`
const modelLabel = (state?: string) => ({ not_downloaded: 'Set up photo search', downloading: 'Downloading search model', loading: 'Warming up search', ready: 'Photo search is ready', sleeping: 'Photo search is ready', error: 'Search needs attention' })[state || ''] || 'Connecting…'

function Logo() {
  return <a className="brand" href="/" aria-label="Indexer Alpha home"><img src="/favicon.svg" alt=""/><span>Indexer <strong>Alpha</strong></span></a>
}

function PhotoGrid({ photos, scores, onOpen, onFavorite }: { photos: Photo[]; scores?: Map<string, number>; onOpen: (id: string) => void; onFavorite: (photo: Photo) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const targetHeight = width < 600 ? 155 : 215
  const rows: { photos: Photo[]; height: number }[] = []
  let row: Photo[] = [], ratio = 0
  for (const photo of photos) {
    row.push(photo); ratio += photo.width / photo.height
    if (ratio * targetHeight + (row.length - 1) * 4 >= width) {
      rows.push({ photos: row, height: (width - (row.length - 1) * 4) / ratio }); row = []; ratio = 0
    }
  }
  if (row.length) rows.push({ photos: row, height: Math.min(targetHeight, (width - (row.length - 1) * 4) / ratio) })
  return <div className={`photo-grid ${scores ? 'search-results' : ''}`} ref={ref}>{rows.map((row, i) => <div className="photo-row" key={i} style={{ height: row.height }}>{row.photos.map(photo => <div className="photo-tile" key={photo.id} style={{ width: row.height * photo.width / photo.height }}>
    <button className="photo-open" onClick={() => onOpen(photo.id)} aria-label={`Open ${photo.name}`}><img src={`/api/photos/${photo.id}/thumbnail`} alt={photo.name} loading="lazy" decoding="async"/><span className="photo-shade"/><span className="photo-name">{photo.name}</span></button>
    <button className={`favorite-button ${photo.favorite ? 'is-favorite' : ''}`} title={photo.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={`${photo.favorite ? 'Unfavorite' : 'Favorite'} ${photo.name}`} onClick={() => onFavorite(photo)}><Star size={18} fill={photo.favorite ? 'currentColor' : 'none'}/></button>
    {scores?.has(photo.id) && <span className="match-badge" aria-label={`${scores.get(photo.id)!.toFixed(1)}% match`} title="Embedding similarity, not a probability">{scores.get(photo.id)!.toFixed(1)}%</span>}
    {photo.status !== 'ready' && <span className={`photo-status ${photo.status}`} title={photo.error || undefined}>{photo.status === 'indexing' ? <LoaderCircle size={13} className="spin"/> : photo.status === 'failed' ? <AlertCircle size={13}/> : <Clock3 size={13}/>} {photo.status === 'queued' ? 'Waiting to index' : photo.status === 'indexing' ? 'Indexing' : 'Couldn’t index'}</span>}
  </div>)}</div>)}</div>
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [status, setStatus] = useState<Status>()
  const [view, setView] = useState<SearchScope>('photos')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult | null>(null)
  const [searchMode, setSearchMode] = useState<SearchMode>('sorted')
  const [cutoff, setCutoff] = useState(DEFAULT_CUTOFF)
  const [searchedQuery, setSearchedQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [settings, setSettings] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailInfo, setDetailInfo] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchController = useRef<AbortController | null>(null)
  const uploadLock = useRef(false)
  const dragDepth = useRef(0)
  const lastPhotoButton = useRef<HTMLElement | null>(null)

  const refresh = useCallback(async () => {
    const [items, state] = await Promise.all([api<Photo[]>('/photos'), api<Status>('/status')])
    setPhotos(items); setStatus(state)
  }, [])

  useEffect(() => {
    let disposed = false
    let events: EventSource | null = null
    let timer: ReturnType<typeof setInterval> | undefined
    connect().then(async () => {
      if (disposed) return
      await refresh()
      if (disposed) return
      events = new EventSource('/api/events')
      events.onmessage = e => { if (!disposed) setStatus(JSON.parse(e.data)) }
      timer = setInterval(() => { api<Photo[]>('/photos').then(p => { if (!disposed) setPhotos(p) }).catch(() => {}) }, 1800)
    }).catch(e => { if (!disposed) setError(e.message) })
    return () => { disposed = true; events?.close(); clearInterval(timer); searchController.current?.abort() }
  }, [refresh])

  const perform = async (operation: () => Promise<unknown>) => {
    try { await operation(); await refresh() } catch (e) { setError((e as Error).message) }
  }
  const clearSearch = () => { searchController.current?.abort(); setSearching(false); setQuery(''); setResults(null); setSearchedQuery('') }
  const navigate = (next: typeof view) => { clearSearch(); setSelectedId(null); setError(''); setView(next); setSidebar(false) }
  const scopedPhotos = photos.filter(photo => view !== 'favorites' || photo.favorite)
  const scopedIds = new Set(scopedPhotos.map(photo => photo.id))
  const scopedHits = results?.scope === view ? results.hits.filter(hit => scopedIds.has(hit.id)) : []
  const searchedCount = scopedHits.length
  const filteredHits = searchHits(scopedHits, searchMode, cutoff)
  const scores = results ? new Map(results.hits.map(hit => [hit.id, matchPercent(hit.score)])) : undefined
  const visible = results ? filteredHits.map(hit => scopedPhotos.find(photo => photo.id === hit.id)).filter((photo): photo is Photo => !!photo) : scopedPhotos
  const selected = visible.find(photo => photo.id === selectedId)
  useEffect(() => {
    // A photo leaving the active scope must not reopen on later navigation.
    if (selectedId && !selected) setSelectedId(null)
  }, [selectedId, selected])
  const selectedIndex = visible.findIndex(photo => photo.id === selectedId)
  const movePhoto = (direction: number) => { const next = visible[selectedIndex + direction]; if (next) setSelectedId(next.id) }

  useEffect(() => {
    if (!selectedId || confirmDelete) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') movePhoto(-1); if (e.key === 'ArrowRight') movePhoto(1) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  async function upload(files: FileList | File[]) {
    if (uploadLock.current) return
    if (files.length > 20) { setError('Please add up to 20 photos at a time.'); return }
    uploadLock.current = true; setError(''); setUploading({ done: 0, total: files.length })
    const failures: string[] = []
    clearSearch(); setView('photos')
    try {
      for (const [i, file] of Array.from(files).entries()) {
        try {
          if (file.size > 25 * 1024 * 1024) throw new Error('larger than 25 MB')
          const body = new FormData(); body.append('file', file)
          await api('/photos', { method: 'POST', body })
          await refresh()
        } catch (e) { failures.push(`${file.name}: ${(e as Error).message}`) }
        setUploading({ done: i + 1, total: files.length })
      }
    } finally {
      uploadLock.current = false; setUploading(null)
      if (input.current) input.current.value = ''
      if (failures.length) setError(failures.join(' · '))
    }
  }

  async function search(e: FormEvent) {
    e.preventDefault()
    if (!query.trim()) { clearSearch(); return }
    searchController.current?.abort()
    const controller = new AbortController(); searchController.current = controller
    setSearching(true); setError('')
    try {
      const response = await api<SearchResult>('/search', { method: 'POST', body: JSON.stringify({ query: query.trim(), scope: view }), signal: controller.signal })
      if (!controller.signal.aborted && response.scope === view) { setResults(response); setSearchedQuery(query.trim()) }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    finally { if (!controller.signal.aborted) setSearching(false) }
  }

  function drop(e: DragEvent) { e.preventDefault(); dragDepth.current = 0; setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files) }
  const pending = (status?.total || 0) - (status?.ready || 0) - (status?.failed || 0)
  const setupNeeded = status?.model === 'not_downloaded' || (status?.model === 'error' && !status.ready)

  return <div className="app" onDragOver={e => e.preventDefault()} onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true) } }} onDragLeave={() => { if (--dragDepth.current <= 0) setDragging(false) }} onDrop={drop}>
    <input type="file" multiple accept="image/jpeg,image/png,image/webp" ref={input} hidden onChange={e => { if (e.target.files?.length) void upload(e.target.files) }}/>
    <header className="topbar">
      <button className="mobile-menu icon-button button-ghost" aria-label="Toggle navigation" onClick={() => setSidebar(!sidebar)}><Menu size={23}/></button>
      <Logo/>
      <div className="search-area">
      <form className={`searchbar ${searching ? 'searchbar-busy' : ''}`} onSubmit={search} role="search">
        <button type="submit" className="search-submit" aria-label={view === 'favorites' ? 'Search favorites' : 'Search photos'} disabled={searching}>{searching ? <LoaderCircle size={23} className="spin"/> : <Search size={23}/>}</button>
        <input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder={view === 'favorites' ? 'Search favorites' : 'Search your photos'} aria-label="Describe a photo" maxLength={500}/>
        {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={clearSearch}><X size={21}/></button>}
      </form>
      <SearchModes mode={searchMode} cutoff={cutoff} scope={view} onChange={setSearchMode}/>
      </div>
    </header>

    <aside className={`sidebar ${sidebar ? 'sidebar-open' : ''}`} aria-label="Main navigation">
      <Button variant="secondary" className="add-button" onClick={() => input.current?.click()} disabled={!!uploading}><Plus size={25}/> Add photos</Button>
      <nav><button className={view === 'photos' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('photos')}><ImageIcon size={21}/><span>Photos</span></button><button className={view === 'favorites' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('favorites')}><Star size={21}/><span>Favorites</span></button></nav>
      <div className="sidebar-rule"/>
      <button className="nav-item" onClick={() => setSettings(true)}><Settings size={21}/><span>Settings</span></button>
      <div className="local-library"><HardDrive size={21}/><div><strong>On this computer</strong><span>{photos.length} {photos.length === 1 ? 'photo' : 'photos'} · {bytes(photos.reduce((total, p) => total + p.size, 0))}</span><div className="storage-line"><i style={{ width: `${Math.min(100, photos.length)}%` }}/></div><p>Your memories stay yours.</p></div></div>
    </aside>
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}

    <main>
      {error && <div className="error-banner" role="alert"><AlertCircle size={19}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={18}/></button></div>}
      {(setupNeeded || status?.model === 'downloading' || status?.model === 'error') && <div className="setup-banner"><div className="setup-icon"><Sparkles size={20}/></div><div><strong>{status?.model === 'downloading' ? 'Getting photo search ready' : status?.model === 'error' ? 'Let’s reconnect photo search' : 'Find your photos with a few words'}</strong><p>{status?.model === 'downloading' ? `Downloading ${bytes(status.download_bytes)} of about ${bytes(status.model_bytes)}. Your photos stay on this computer.` : status?.model === 'error' ? 'Open settings to see what happened and retry.' : 'Set up local AI search once. Then describe a scene, subject, or moment.'}</p>{status?.model === 'downloading' && <div className="download-progress"><i style={{ width: `${Math.max(2, status.download_bytes / status.model_bytes * 100)}%` }}/></div>}</div><Button variant="secondary" onClick={() => setSettings(true)}>{status?.model === 'downloading' ? 'View progress' : 'Set up search'}<ArrowUpRight size={16}/></Button></div>}

      <section className="library-heading"><div>{results && <button className="back-link" onClick={clearSearch}><ArrowLeft size={16}/> {view === 'favorites' ? 'All favorites' : 'All photos'}</button>}<h1>{results ? `“${searchedQuery}”` : view === 'favorites' ? 'Favorites' : 'Your photos'}</h1><p>{searching ? 'Finding the photos you’re thinking of…' : results ? `${searchMode === 'definitive' ? 'Filtered matches' : 'Ranked matches'} · searched ${searchedCount} ${view === 'favorites' ? 'favorites' : 'photos'}` : photos.length ? 'Every picture. A little easier to find.' : 'A home for your photos. A search for your memories.'}</p></div><div className="library-heading-actions">{photos.length > 0 && <span className="photo-count">{visible.length} {visible.length === 1 ? 'photo' : 'photos'}</span>}<Button variant="ghost" className="inline-upload" onClick={() => input.current?.click()} disabled={!!uploading}><Upload size={18}/> Add photos</Button></div></section>

      {searchMode === 'definitive' && <section className="search-options" aria-label="Match cutoff">
        <div className="cutoff-control">
          <label htmlFor="match-cutoff">Minimum match <strong>{cutoff}%</strong></label>
          <input id="match-cutoff" type="range" min="0" max="100" step="1" value={cutoff} onChange={e => setCutoff(Number(e.target.value))} aria-valuetext={`${cutoff} percent minimum match`}/>
          <div className="cutoff-presets" role="group" aria-label="Cutoff presets">{[60, 70, 80].map(value => <button type="button" key={value} aria-pressed={cutoff === value} onClick={() => setCutoff(value)}>{value}%</button>)}</div>
        </div>
        {results && <span className="cutoff-count" aria-live="polite">{visible.length} of {searchedCount} {view === 'favorites' ? 'favorites' : 'photos'}</span>}
      </section>}

      {uploading && <div className="activity-strip" role="status"><LoaderCircle size={16} className="spin"/> Adding photos · {uploading.done} of {uploading.total}<div className="activity-track"><i style={{ width: `${uploading.done / uploading.total * 100}%` }}/></div></div>}
      {pending > 0 && !setupNeeded && <div className="activity-strip" role="status">{status?.paused ? <Pause size={16}/> : <LoaderCircle size={16} className="spin"/>}<span>{status?.model === 'loading' ? 'Warming up the search model…' : `${status?.ready} of ${status?.total} photos searchable${status?.paused ? ' · paused' : ''}`}</span><button onClick={() => void perform(() => api(`/indexing/${status?.paused ? 'resume' : 'pause'}`, { method: 'POST' }))}>{status?.paused ? <><Play size={14}/> Resume</> : <><Pause size={14}/> Pause</>}</button></div>}
      {!!status?.failed && <div className="activity-strip failed-strip"><AlertCircle size={16}/><span>{status.failed} {status.failed === 1 ? 'photo couldn’t' : 'photos couldn’t'} be indexed.</span><button onClick={() => void perform(() => api('/indexing/retry', { method: 'POST' }))}><RotateCcw size={14}/> Retry</button></div>}

      {visible.length > 0 ? <><div className="grid-label"><span>{results ? (searchMode === 'definitive' ? `Matches at or above ${cutoff}%` : 'Ranked by relevance') : view === 'favorites' ? 'Your favorites' : 'In your library'}</span>{!results && scopedPhotos.every(photo => photo.status === 'ready') && <span className="ready-caption"><Check size={13}/> Ready to search</span>}</div><PhotoGrid photos={visible} scores={scores} onOpen={id => { lastPhotoButton.current = document.activeElement as HTMLElement; setSelectedId(id); setDetailInfo(false) }} onFavorite={photo => void perform(() => api(`/photos/${photo.id}/favorite`, { method: 'POST' }))}/></> : results ? <div className="empty-state search-empty" role="status"><Search size={40} aria-hidden="true"/><h2>{view === 'favorites' && searchedCount === 0 ? 'No searchable favorites in these results' : searchMode === 'definitive' ? `No photos meet the ${cutoff}% cutoff` : 'No searchable photos in these results'}</h2><p>{view === 'favorites' && searchedCount === 0 ? 'Favorite an indexed photo, or wait for indexing to finish, then search again.' : searchMode === 'definitive' ? 'Lower the minimum match or try a different description.' : 'Search again to refresh your results.'}</p>{searchMode === 'definitive' && <Button variant="secondary" onClick={() => setSearchMode('sorted')}>Show ranked results</Button>}</div> : <div className="empty-state"><div className="empty-art" aria-hidden="true"><div className="art-card art-back"><div className="art-sun"/><div className="art-hill"/></div><div className="art-card art-front"><div className="art-sun"/><div className="art-hill"/><div className="art-hill second"/></div><div className="art-spark"><Plus size={26}/></div></div><h2>{view === 'favorites' ? 'Keep your favorites close' : 'Your photos, a few words away'}</h2><p>{view === 'favorites' ? 'Tap the star on a photo to find it here.' : 'Add a few photos, then find them by describing what you remember.'}</p>{view !== 'favorites' && <><Button onClick={() => input.current?.click()} disabled={!!uploading}><Upload size={18}/> Add your photos</Button><span className="file-note">or drop them anywhere · JPG, PNG, WebP</span></>}</div>}
    </main>

    {dragging && <div className="drop-overlay"><div><Upload size={44}/><h2>Drop your photos here</h2><p>Up to 20 photos at a time. Originals stay untouched.</p></div></div>}

    <Dialog.Root open={settings} onOpenChange={setSettings}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="settings-dialog"><div className="dialog-header"><Dialog.Title>Settings</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="Close settings"><X size={21}/></Button></Dialog.Close></div><Dialog.Description className="dialog-description">Your library, on your computer.</Dialog.Description>
      <div className="settings-section"><div className="section-title"><Sparkles size={20}/><h3>Photo search</h3></div><div className={`model-status ${status?.model === 'error' ? 'status-error' : ''}`}><span className={`status-dot ${['ready', 'sleeping'].includes(status?.model || '') ? 'green' : ''}`}/>{modelLabel(status?.model)}</div><p>EmbeddingGemma 2 understands your photos so you can search with a description. The model runs locally, using your GPU when available.</p>
      {status?.model_error && <p className="model-error">{status.model_error}</p>}
      {status?.model === 'downloading' ? <><div className="download-progress"><i style={{ width: `${Math.max(2, status.download_bytes / status.model_bytes * 100)}%` }}/></div><small>{bytes(status.download_bytes)} of approximately {bytes(status.model_bytes)}</small></> : ['not_downloaded', 'error'].includes(status?.model || '') ? <Button onClick={() => void perform(() => api('/model/download', { method: 'POST' }))}><Download size={17}/>{status?.model === 'error' ? 'Retry setup' : `Download model · ${bytes(status?.model_bytes || 1526000000)}`}</Button> : <div className="ready-note"><Check size={17}/> Downloaded. Works offline.</div>}
      </div>
      <div className="settings-section"><div className="setting-row"><div><h3>Processing</h3><p>Automatic uses your GPU when it’s available.</p></div><select aria-label="Processing device" value={status?.mode || 'auto'} onChange={e => void perform(() => api('/device', { method: 'POST', body: JSON.stringify({ mode: e.target.value }) }))}><option value="auto">Automatic</option><option value="cpu">CPU only</option></select></div><div className="resource-summary"><span><HardDrive size={15}/>{status?.device === 'cuda' ? 'NVIDIA GPU' : status?.device === 'cpu' ? 'CPU' : 'Loads when needed'}</span><span>{bytes((status?.metrics.api_rss || 0) + (status?.metrics.rss || 0))} memory</span>{!!status?.metrics.gpu_reserved && <span>{bytes(status.metrics.gpu_reserved)} GPU</span>}</div><small>The model releases its memory after five idle minutes.</small></div>
      <div className="settings-section"><h3>Your library</h3><p>{photos.length} imported photos. Removing an imported copy never changes the original file.</p><Button variant="ghost" className="danger-text" onClick={() => setConfirmReset(true)} disabled={!photos.length}><Trash2 size={17}/> Clear imported library</Button></div>
      <div className="settings-footer"><ShieldCheck size={16}/> No cloud uploads. No external search API.</div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>

    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open) setSelectedId(null) }}><Dialog.Portal><Dialog.Overlay className="viewer-overlay"/><Dialog.Content className="viewer" onCloseAutoFocus={e => { e.preventDefault(); lastPhotoButton.current?.focus() }}><div className="viewer-toolbar"><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="Close photo"><ArrowLeft size={23}/></Button></Dialog.Close><Dialog.Title>{selected?.name}</Dialog.Title><div className="viewer-tools"><Button variant="ghost" size="icon" aria-label="Favorite photo" onClick={() => selected && void perform(() => api(`/photos/${selected.id}/favorite`, { method: 'POST' }))}><Star size={22} fill={selected?.favorite ? 'currentColor' : 'none'}/></Button><Button variant="ghost" size="icon" aria-label="Photo information" onClick={() => setDetailInfo(!detailInfo)}><Info size={22}/></Button><Button variant="ghost" size="icon" aria-label="Remove photo" onClick={() => setConfirmDelete(true)}><Trash2 size={21}/></Button></div></div><Dialog.Description className="sr-only">Photo preview. Use the arrow keys to move between photos. Escape closes the preview.</Dialog.Description><div className="viewer-body"><Button variant="ghost" size="icon" className="viewer-arrow" disabled={selectedIndex <= 0} onClick={() => movePhoto(-1)} aria-label="Previous photo"><ChevronLeft size={28}/></Button>{selected && <img className="full-photo" src={`/api/photos/${selected.id}/preview`} alt={selected.name}/>}<Button variant="ghost" size="icon" className="viewer-arrow" disabled={selectedIndex >= visible.length - 1} onClick={() => movePhoto(1)} aria-label="Next photo"><ChevronRight size={28}/></Button>{detailInfo && selected && <aside className="photo-info"><h3>Details</h3><strong>{selected.name}</strong><p>{selected.width} × {selected.height}</p><p>{bytes(selected.size)}</p><p>Added {new Date(selected.created).toLocaleDateString()}</p><p>{selected.status === 'ready' ? 'Ready for photo search' : selected.status}</p>{selected.error && <p>{selected.error}</p>}</aside>}</div><span className="viewer-counter">{selectedIndex + 1} / {visible.length}</span></Dialog.Content></Dialog.Portal></Dialog.Root>

    <AlertDialog.Root open={confirmDelete || confirmReset} onOpenChange={open => { if (!open) { setConfirmDelete(false); setConfirmReset(false) } }}><AlertDialog.Portal><AlertDialog.Overlay className="dialog-overlay confirmation-overlay"/><AlertDialog.Content className="confirm-dialog"><AlertDialog.Title>{confirmReset ? 'Clear this library?' : 'Remove this photo?'}</AlertDialog.Title><AlertDialog.Description>{confirmReset ? 'All imported copies and search data will be removed. The downloaded search model will stay.' : 'The imported copy and its search data will be removed.'} Your original files won’t be changed.</AlertDialog.Description><div className="confirm-actions"><AlertDialog.Cancel asChild><Button variant="ghost">Cancel</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button variant="destructive" onClick={() => {
      const resetting = confirmReset, id = selectedId
      void perform(async () => { await api(resetting ? '/library/reset' : `/photos/${id}`, { method: resetting ? 'POST' : 'DELETE' }); setSelectedId(null); clearSearch() })
      setConfirmDelete(false); setConfirmReset(false)
    }}>{confirmReset ? 'Clear library' : 'Remove photo'}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </div>
}
