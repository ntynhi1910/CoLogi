
import { useId } from 'react'

type VehicleLoadMeterProps = {
  allocatedKg: number
  capacityKg: number
  className?: string
}

const formatKg = (value: number) =>
  `${Math.round(value).toLocaleString('vi-VN')} kg`

export default function VehicleLoadMeter({
  allocatedKg,
  capacityKg,
  className = '',
}: VehicleLoadMeterProps) {
  const clipId = useId()

  const safeAllocated = Number.isFinite(allocatedKg)
    ? Math.max(0, allocatedKg)
    : 0

  const safeCapacity = Number.isFinite(capacityKg)
    ? Math.max(0, capacityKg)
    : 0

  const percent = safeCapacity > 0
    ? Math.min(100, (safeAllocated / safeCapacity) * 100)
    : 0

  const remaining = Math.max(0, safeCapacity - safeAllocated)

  // Thùng xe có chiều cao 58 đơn vị.
  // Màu xanh dâng từ đáy y=76 lên trên.
  const cargoHeight = 58
  const cargoBottom = 76
  const fillHeight = cargoHeight * percent / 100
  const fillY = cargoBottom - fillHeight

  return (
    <div className={`cologi-load ${className}`.trim()}>
      <div className="cologi-load__panel">

        <div className="cologi-load__cargo-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <path
              d="M24 5 38 13v17L24 38 10 30V13L24 5Z"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <path
              d="m10 13 14 8 14-8M24 21v17M17 9l14 8"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="cologi-load__metric">
          <span>Đã phân bổ</span>
          <strong>{formatKg(safeAllocated)}</strong>
        </div>

        <div className="cologi-load__metric">
          <span>Sức chứa</span>
          <strong>{formatKg(safeCapacity)}</strong>
        </div>

        <div className="cologi-load__metric cologi-load__metric--percent">
          <span>Mức sử dụng xe</span>
          <strong>{Math.round(percent)}%</strong>
        </div>

        <div className="cologi-load__truck">
          <svg
            viewBox="0 0 210 105"
            role="img"
            aria-label={`Xe tải đã sử dụng ${Math.round(percent)}% sức chứa`}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x="9" y="18" width="125" height="58" rx="9" />
              </clipPath>
            </defs>

            {/* Nền thùng xe */}
            <rect
              x="9"
              y="18"
              width="125"
              height="58"
              rx="9"
              fill="#E5F0E9"
            />

            {/* Màu xanh tăng từ dưới lên */}
            <g clipPath={`url(#${clipId})`}>
              <rect
                x="9"
                y={fillY}
                width="125"
                height={fillHeight}
                fill="#24A367"
              />
            </g>

            {/* Viền thùng xe */}
            <rect
              x="9"
              y="18"
              width="125"
              height="58"
              rx="9"
              fill="none"
              stroke="#126443"
              strokeWidth="2.8"
            />

            {/* Cabin và đầu xe */}
            <path
              d="M141 35H165C170 35 173 38 176 42L189 58V76H141V35Z"
              fill="#F4FAF6"
              stroke="#126443"
              strokeWidth="2.8"
              strokeLinejoin="round"
            />

            {/* Cửa kính */}
            <path
              d="M157 42H164C167 42 168 43 170 46L179 57H157V42Z"
              fill="#D8EEE2"
              stroke="#126443"
              strokeWidth="2"
              strokeLinejoin="round"
            />

            {/* Tay nắm */}
            <path
              d="M158 65H169"
              stroke="#126443"
              strokeWidth="2"
              strokeLinecap="round"
            />

            {/* Bánh xe */}
            <circle cx="44" cy="78" r="13" fill="#114E35" />
            <circle cx="44" cy="78" r="6" fill="#FFFFFF" />

            <circle cx="163" cy="78" r="13" fill="#114E35" />
            <circle cx="163" cy="78" r="6" fill="#FFFFFF" />
          </svg>
        </div>
      </div>

      <div className="cologi-load__remaining">
        <span>Còn trống:</span>
        <strong>{formatKg(remaining)}</strong>
      </div>
    </div>
  )
}
