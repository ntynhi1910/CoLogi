
import ReconciliationWorkspaceLegacy from './ReconciliationWorkspaceLegacy'

type Audience =
  | 'manager'
  | 'supplier'
  | 'provider'
  | 'purchasing'

type Props = {
  audience: Audience
}

export default function ReconciliationWorkspace({
  audience,
}: Props) {
  return (
    <ReconciliationWorkspaceLegacy audience={audience} />
  )
}
