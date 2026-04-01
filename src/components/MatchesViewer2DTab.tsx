import Viewer2D from './Viewer2D'

interface Round {
  roundIndex: number
  startTick: number
  endTick: number
}

interface MatchesViewer2DTabProps {
  matchId: string
  roundIndex: number
  initialTick: number
  roundStartTick: number
  roundEndTick: number
  mapName: string
  onClose: () => void
  isFullGame?: boolean
  allRounds?: Round[]
}

export default function MatchesViewer2DTab(props: MatchesViewer2DTabProps) {
  return <Viewer2D {...props} />
}
