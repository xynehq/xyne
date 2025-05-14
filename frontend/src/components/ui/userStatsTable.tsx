import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AuthType } from "shared/types"

export const UserStatsTable = ({
  userStats,
  type,
}: {
  userStats: { [email: string]: any }
  type: AuthType
}) => {
  return (
    <Table className="ml-[10px] mt-[10px] max-h-[400px]">
      <TableHeader>
        <TableRow>
          {type === AuthType.ServiceAccount && (
            <TableHead> User Email </TableHead>
          )}
          <TableHead>Gmail</TableHead>
          <TableHead>Drive</TableHead>
          <TableHead>Contacts</TableHead>
          <TableHead>Events</TableHead>
          <TableHead>Attachments</TableHead>
          <TableHead>%</TableHead>
          <TableHead>Est (minutes)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Object.entries(userStats).map(([email, stats]) => {
          const percentage: number = parseFloat(
            (
              ((stats.gmailCount + stats.driveCount) * 100) /
              (stats.totalDrive + stats.totalMail)
            ).toFixed(2),
          )
          const elapsed = (new Date().getTime() - stats.startedAt) / (60 * 1000)
          const eta =
            percentage !== 0 ? (elapsed * 100) / percentage - elapsed : 0
          return (
            <TableRow key={email}>
              {type === AuthType.ServiceAccount && (
                <TableCell className={`${stats.done ? "text-lime-600" : ""}`}>
                  {email}
                </TableCell>
              )}
              <TableCell>{stats.gmailCount}</TableCell>
              <TableCell>{stats.driveCount}</TableCell>
              <TableCell>{stats.contactsCount}</TableCell>
              <TableCell>{stats.eventsCount}</TableCell>
              <TableCell>{stats.mailAttachmentCount}</TableCell>
              <TableCell>{percentage}</TableCell>
              <TableCell>{eta.toFixed(0)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
