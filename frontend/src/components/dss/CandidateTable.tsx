import type { F1CandidateGroup, F1CandidateWindow, F1DisplayLabels } from '../../types/f1'
import { candidateFacts, commonDuration, deliveryDate, deliveryWarning, demandCode, groupIds, groupLabel, missing, timeWindow, weight } from './f1Display'
import type { DemandResult } from './f1Display'

export default function CandidateTable({ groups, results, labels, at, openGroup }: {
  groups: (F1CandidateWindow | F1CandidateGroup)[]
  results: DemandResult[]
  labels?: F1DisplayLabels
  at?: string
  openGroup?: (code: string) => void
}) {
  if (!groups.length) return <div className="dssr-empty-small">Không có nhóm ứng viên.</div>

  const memberships = groups.flatMap(groupIds)
  const byId = new Map(results.map((item) => [item.demand_id, item]))

  return (
    <>
      <p className="dssf-candidate-intro"><strong>{groups.length} nhóm · {new Set(memberships).size} nhu cầu duy nhất · {memberships.length} lượt tham gia nhóm</strong></p>
      <p className="dssf-candidate-intro">
        F1 tìm các nhóm tương thích tối đại trong giới hạn số nhu cầu mỗi nhóm.
        Một nhu cầu có thể xuất hiện trong nhiều nhóm. F3–F5 chưa khả dụng.
      </p>
      <div className="dssf-candidate-list">
        {groups.map((group, index) => {
          const { ids, members, window, outletCount, outletNames, missingOutletNames, categoryCodes, totalKg } = candidateFacts(group, byId, labels)
          const code = 'group_code' in group ? group.group_code : null
          const warning = deliveryWarning(window?.requested_date, at)
          return (
            <article className="dssf-candidate" key={code ?? ids.join(',')}>
              <div className="dssf-candidate-heading">
                <div><h3>{groupLabel(index)}</h3><small>{ids.length} nhu cầu · {outletCount ?? missing} Outlet</small></div>
                {code && openGroup && <button type="button" className="dssr-secondary-button" onClick={() => openGroup(code)}>Chi tiết →</button>}
              </div>
              <dl className="dssf-facts">
                <div><dt>Nhu cầu</dt><dd>{members.map(demandCode).join(', ')}</dd></div>
                <div><dt>Outlet</dt><dd>{outletNames.join(', ')}
                  {missingOutletNames && <small className="dssf-evidence-line">Chưa có tên cho một số Outlet.</small>}
                </dd></div>
                <div><dt>Ngày giao</dt><dd>{deliveryDate(window?.requested_date)}{warning && <small className="dssf-past-date">{warning}</small>}</dd></div>
                <div><dt>Khung giờ và thời lượng chung</dt><dd>{timeWindow(window?.common_start_time, window?.common_end_time)} · {commonDuration(window)}</dd></div>
                <div><dt>Nhóm hàng</dt><dd>{categoryCodes.join(', ')}</dd></div>
                <div><dt>Tổng khối lượng yêu cầu</dt><dd>{weight(totalKg)}</dd></div>
              </dl>
            </article>
          )
        })}
      </div>
    </>
  )
}
