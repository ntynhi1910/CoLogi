import { useCallback, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { apiRequest } from '../../services/api/client'
import { useAuth } from '../../contexts/useAuth'
import { useDssQuery } from '../../services/dss/useDssQuery'
import './DSSDashboardPage.css'
import './OperationalSourcesPage.css'

type Field = [key: string, label: string, type?: string, options?: string[]]
type Dataset = { label: string; unit?: string; fields: Field[]; payload?: Field[] }
type Values = Record<string, unknown>
type SourceRow = Values & { id: number; scope?: Values; data?: Values; approval?: string }
const weekdays = ['0', '1', '2', '3', '4', '5', '6']
const tabs: Record<string, Dataset> = {
  windows: { label: 'Khung nhận định kỳ', fields: [
    ['outlet', 'Outlet ID', 'number'], ['day_of_week', 'Thứ (0 là thứ Hai)', 'select', weekdays],
    ['start_time', 'Giờ mở', 'time'], ['end_time', 'Giờ đóng', 'time'],
    ['is_active', 'Trạng thái', 'select', ['ACTIVE', 'INACTIVE']],
  ] },
  slots: { label: 'Slot theo ngày', fields: [
    ['outlet', 'Outlet ID', 'number'], ['slot_date', 'Ngày nhận', 'date'],
    ['start_time', 'Giờ bắt đầu', 'time'], ['end_time', 'Giờ kết thúc', 'time'],
    ['slot_type', 'Loại', 'select', ['AVAILABLE', 'BLOCKED']],
    ['status', 'Trạng thái', 'select', ['OPEN', 'RESERVED', 'CONFIRMED', 'REJECTED', 'CANCELLED']],
    ['reason', 'Lý do (tuỳ chọn)'],
  ] },
  CALENDAR: { label: 'Xác nhận lịch ngày', fields: [['outlet_id', 'Outlet ID', 'number']] },
  TRAVEL: { label: 'Chặng đường', fields: [['origin', 'Điểm đầu'], ['destination', 'Điểm cuối']],
    payload: [['minutes', 'Phút di chuyển', 'number'], ['distance_km', 'Cự ly (km)', 'decimal']] },
  SERVICE: { label: 'Xử lý tại điểm', fields: [
    ['point', 'Điểm phục vụ'],
    ['role', 'Dịch vụ', 'select', ['SUPPLIER_PICKUP', 'OUTLET_DELIVERY', 'HUB_RECEIVE', 'HUB_DISPATCH']],
  ], payload: [['minutes', 'Phút xử lý', 'number']] },
  HUB_HOURS: { label: 'Giờ hoạt động Hub', fields: [['hub_id', 'Hub ID', 'number']],
    payload: [['start_time', 'Giờ mở', 'time'], ['end_time', 'Giờ đóng', 'time']] },
  HUB_COVERAGE: { label: 'Phạm vi qua Hub', fields: [
    ['provider_id', 'Nhà vận chuyển ID', 'number'], ['hub_id', 'Hub ID', 'number'],
    ['direction', 'Chiều vận chuyển', 'select', ['INBOUND', 'OUTBOUND']], ['endpoint', 'Điểm Supplier hoặc Outlet'],
  ] },
  QUOTE: { label: 'Báo giá theo wave', fields: [
    ['offer_id', 'Vehicle Offer ID', 'number'], ['phase', 'Chặng', 'select', ['DIRECT', 'INBOUND', 'OUTBOUND']],
    ['route', 'Các điểm theo thứ tự, cách nhau bằng dấu phẩy'],
  ], payload: [['fixed', 'Cước cố định (VND, tuỳ chọn)', 'decimal'], ['per_km', 'Cước mỗi km (VND, tuỳ chọn)', 'decimal'],
    ['surcharge', 'Phụ phí cố định (VND, tuỳ chọn)', 'decimal']] },
  HUB_FEE: { label: 'Phí xử lý Hub', fields: [['hub_id', 'Hub ID', 'number'], ['profile_id', 'CostProfile ID', 'number']],
    payload: [['fixed', 'Phí xử lý (VND)', 'decimal']] },
  BASELINE: { label: 'Chi phí giao riêng', fields: [['demand_id', 'Demand ID', 'number'], ['profile_id', 'CostProfile ID', 'number']],
    payload: [['amount_vnd', 'Chi phí giao riêng (VND)', 'decimal'], ['weight_kg', 'Khối lượng Demand (kg)', 'decimal']] },
  BASELINE_RATE: { label: 'Cước giao riêng theo tuyến', fields: [
    ['supplier_id', 'Supplier ID', 'number'], ['outlet_id', 'Outlet ID', 'number'], ['profile_id', 'CostProfile ID', 'number'],
  ], payload: [['fixed', 'Cước cố định (VND, tuỳ chọn)', 'decimal'], ['per_km', 'Cước mỗi km (VND, tuỳ chọn)', 'decimal'],
    ['surcharge', 'Phụ phí cố định (VND, tuỳ chọn)', 'decimal']] },
  profiles: { label: 'Hồ sơ chi phí', fields: [
    ['profile_code', 'Mã hồ sơ'], ['profile_name', 'Tên hồ sơ'], ['fixed_transport_cost', 'Cước cố định tham khảo', 'decimal'],
    ['cost_per_km', 'Đơn giá/km tham khảo (tuỳ chọn)', 'decimal'], ['additional_handling_cost', 'Phí xử lý tham khảo', 'decimal'],
    ['is_active', 'Trạng thái', 'select', ['ACTIVE', 'INACTIVE']],
  ] },
  POLICY: { label: 'Chính sách phân bổ', fields: [['profile_id', 'CostProfile ID', 'number']],
    payload: [['allocation_method', 'Phương pháp', 'select', ['WEIGHT', 'ORDER_COUNT']],
      ['rounding_unit_vnd', 'Đơn vị làm tròn (VND)', 'number'], ['service_basis', 'Phạm vi dịch vụ so sánh']] },
}

function extract(form: FormData, fields: Field[]) {
  return Object.fromEntries(fields.map(([key, , type]) => {
    const raw = String(form.get(key) ?? '').trim()
    if (key === 'is_active') return [key, raw === 'ACTIVE']
    if (key === 'route') return [key, raw.split(',').map((p) => p.trim()).filter(Boolean)]
    if (key === 'cost_per_km' && !raw) return [key, null]
    return [key, type === 'number' ? Number(raw) : raw]
  }))
}

function fill(row: SourceRow | undefined, field: string) {
  const value = row?.scope?.[field] ?? row?.data?.[field] ?? row?.[field]
  if (field === 'is_active') return value === false ? 'INACTIVE' : 'ACTIVE'
  if (Array.isArray(value)) return value.join(', ')
  if (value != null) return String(value)
  const specs = row?.data?.components
  const codes: Record<string, string> = { fixed: row?.kind === 'HUB_FEE' ? 'HUB_HANDLING' : 'TRANSPORT_BASE',
    per_km: 'DISTANCE', surcharge: 'SURCHARGE' }
  if (codes[field] && Array.isArray(specs)) {
    const part = (specs as { covers: string[]; rate_vnd: string }[]).find((component) => component.covers.includes(codes[field]))
    return part?.rate_vnd ?? ''
  }
  return ''
}

const base = '/planning/operational/'

function Editor({ name, manager }: { name: string; manager: boolean }) {
  const config = tabs[name]
  const [selected, select] = useState<SourceRow>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generic = !['windows', 'slots', 'profiles'].includes(name)
  const endpoint = generic ? 'evidence/' : name + '/'
  const kind = name === 'BASELINE_RATE' ? 'BASELINE' : name
  const load = useCallback(async () => {
    const result = await apiRequest<SourceRow[]>(base + endpoint + (generic ? '?kind=' + kind : ''))
    return kind === 'BASELINE' ? result.filter((row) => !!row.scope?.supplier_id === (name === 'BASELINE_RATE')) : result
  },
    [endpoint, generic, kind, name])
  const rows = useDssQuery(load)
  const fields: Field[] = generic ? [
    ...config.fields, ...(config.payload ?? []), ['valid_from', 'Có hiệu lực từ', 'date'],
    ['valid_to', 'Có hiệu lực đến', 'date'], ['source_reference', 'Mã tài liệu nguồn'],
    ...(manager ? [['provenance', 'Phân loại nguồn', 'select', ['OPERATIONAL', 'SYNTHETIC/CAPSTONE']],
      ['scenario', 'Mã Capstone (tuỳ chọn)']] as Field[] : []),
    ...(manager ? [['approval', 'Phê duyệt', 'select', ['REFERENCE', 'APPROVED', 'REVOKED']]] as Field[] : []),
  ] : [...config.fields, ...(name === 'profiles' ? [] : [['source', 'Nguồn'], ['source_reference', 'Mã tài liệu nguồn']] as Field[])]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const scope = extract(form, config.fields)
    let data = extract(form, config.payload ?? [])
    if (['QUOTE', 'HUB_FEE', 'BASELINE_RATE'].includes(name)) {
      const components = [['fixed', 'FIXED', name === 'HUB_FEE' ? 'HUB_HANDLING' : 'TRANSPORT_BASE'],
        ['per_km', 'PER_KM', 'DISTANCE'], ['surcharge', 'FIXED', 'SURCHARGE']]
        .filter(([key]) => data[key]).map(([key, pricing_basis, cover]) => ({
          pricing_basis, rate_vnd: data[key], covers: [cover],
        }))
      data = { components }
    }
    if (name === 'POLICY') data.distance_basis = 'FIRST_SERVICE_TO_LAST_SERVICE'
    const reference = Object.fromEntries(['source', 'source_reference'].map((key) => [key, form.get(key)]))
    const payload = generic ? {
      kind, scope, data, valid_from: form.get('valid_from'), valid_to: form.get('valid_to'),
      source_reference: reference.source_reference, approval: form.get('approval') ?? 'REFERENCE',
      provenance: form.get('provenance') ?? 'OPERATIONAL', scenario: form.get('scenario') ?? '',
    } : { ...scope, ...(name === 'profiles' ? { currency_code: 'VND' } : reference) }
    setBusy(true)
    setMessage('')
    try {
      const change = !generic && selected
      await apiRequest(base + endpoint + (change ? change.id + '/' : ''), {
        method: change ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      })
      setMessage('Đã lưu.')
      select(undefined)
      rows.reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không lưu được dữ liệu.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="ops-card">
    <h2>{config.label}</h2>
    <div className="ops-scroll"><table>
      <thead><tr><th>ID</th><th>Phạm vi</th><th>Trạng thái</th><th>Nguồn</th><th>Thao tác</th></tr></thead>
      <tbody>{rows.data?.map((row) => <tr key={row.id}>
        <td>{row.id}</td>
        <td>{config.fields.slice(0, 3).map(([key]) => fill(row, key)).join(' · ')}</td>
        <td>{row.approval ?? fill(row, name === 'slots' ? 'status' : 'is_active')}</td>
        <td>{[row.provenance, fill(row, 'source_reference')].filter(Boolean).join(' · ') || '—'}</td>
        <td><button type="button" onClick={() => select(row)}>Mở</button></td>
      </tr>)}</tbody>
    </table></div>
    {rows.loading && <p>Đang tải dữ liệu…</p>}
    {rows.error && <p role="alert">Không tải được dữ liệu.</p>}
    {rows.data?.length === 0 && <p>Chưa có bản ghi.</p>}
    <form key={selected?.id ?? 'new'} onSubmit={submit}>
      <h3>{selected ? 'Cập nhật bản ghi #' + selected.id : 'Thêm bản ghi'}</h3>
      {generic && fields.some(([key]) => ['origin', 'point', 'route', 'endpoint'].includes(key)) &&
        <p>Dùng mã loại và ID của điểm, ví dụ SUPPLIER:3, HUB:1 hoặc OUTLET:2.</p>}
      <div className="ops-fields">{fields.map(([key, label, type, options]) => <label key={key}>
        {label}
        {options ? <select name={key} defaultValue={fill(selected, key) || options[0]}>
          {options.map((option) => <option key={option}>{option}</option>)}
        </select> : <input name={key} defaultValue={fill(selected, key)}
          required={!label.includes('tuỳ chọn')} type={type === 'decimal' ? 'text' : type ?? 'text'}
          min={type === 'number' ? 0 : undefined} inputMode={type === 'decimal' ? 'decimal' : undefined} />}
      </label>)}</div>
      <div className="ops-actions"><button disabled={busy} type="submit">{busy ? 'Đang lưu…' : 'Lưu dữ liệu'}</button>
        {selected && <button type="button" onClick={() => select(undefined)}>Tạo bản ghi khác</button>}
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  </section>
}

export default function OperationalSourcesPage() {
  const { user } = useAuth()
  const manager = !!user?.roles.includes('MANAGER')
  const names = manager ? Object.keys(tabs) : ['QUOTE', 'HUB_COVERAGE']
  const [tab, setTab] = useState(names[0])
  if (user?.capstone_scenario) return <Navigate to={manager ? '/dss' : '/'} replace />
  return <main className="dssd-page ops-page">
    <header className="dssd-header"><div><h1>Dữ liệu vận hành DSS</h1></div></header>
    <nav className="ops-tabs" aria-label="Chọn nhóm dữ liệu DSS">
      {names.map((name) => <button key={name} type="button" onClick={() => setTab(name)}
        aria-pressed={tab === name}>{tabs[name].label}</button>)}
    </nav>
    <Editor key={tab} name={tab} manager={manager} />
  </main>
}
