import { useCallback, useState, type FormEvent } from 'react'
import { ApiError } from '../../services/api/client'
import { dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'

export default function CloseUnplannedForm({
  demands,
  runCode,
  embedded = false
}: {
  demands: { id: number; label: string }[]
  runCode?: string
  embedded?: boolean
}) {
  const [id, setId] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean }>()
  const loadAttempt = useCallback(() => id ? dssService.getUnplannedRequest(id) : Promise.resolve(null), [id])
  const attempt = useDssQuery(loadAttempt)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!id || !attempt.data || !reason.trim() || !confirmed || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await dssService.closeUnplanned(Number(id), attempt.data.supplier_request_id, runCode, reason.trim())
      setMessage({ text: 'Đã kết thúc lập kế hoạch và thông báo cho các bên. Nhu cầu vẫn có thể lập kế hoạch lại.' })
      setConfirmed(false)
    } catch (error) {
      const detail = error instanceof ApiError && error.data && typeof error.data === 'object' && 'detail' in error.data
        ? String(error.data.detail) : 'Không thể kết thúc lần lập kế hoạch. Vui lòng kiểm tra và thử lại.'
      setMessage({ text: detail, error: true })
    } finally {
      setBusy(false)
    }
  }

  if (!demands.length) return null
  const formContent = (
    <form className="dssc-form" onSubmit={save}>
      <p>Cam kết cung ứng sẽ bị hủy và lượng hàng giữ chỗ được giải phóng. Số tồn thực tế và trạng thái Demand được giữ nguyên.</p>
      <label className="dssc-field">Nhu cầu<select required value={id} onChange={event => { setId(event.target.value); setConfirmed(false) }} disabled={busy}>
        <option value="">Chọn nhu cầu</option>{demands.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
      {id && <p role="status">{attempt.loading ? 'Đang tải yêu cầu cung ứng…' : attempt.data
        ? `Yêu cầu cung ứng ${attempt.data.request_code}` : 'Không tải được yêu cầu cung ứng.'}</p>}
      <label className="dssc-field">Lý do<textarea required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} /></label>
      <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /> Tôi xác nhận đã kết thúc lần lập kế hoạch và không còn phương án khả thi.</label>
      <button className="dssr-primary-button" disabled={busy || !id || !attempt.data || !reason.trim() || !confirmed} type="submit">{busy ? 'Đang xử lý…' : 'Xác nhận hủy cam kết cung ứng'}</button>
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
        </form>
  )

  if (embedded) {
    return formContent
  }

  return (
    <details className="dssr-panel">
      <summary>
        Kết thúc nhu cầu không lập được kế hoạch
      </summary>
      {formContent}
    </details>
  )
}
