export interface AttendanceActivityWindow {
  startsAt: Date;
  endsAt: Date;
}
export interface AttendanceRecord {
  attendanceStatus: string | null;
  attendanceRecordedAt: Date | null;
  attendanceSource?: string | null;
}
/** A system deadline record retains its real processing timestamp, including after an appeal. */
export function validAttendanceRecord(activity: AttendanceActivityWindow, row: AttendanceRecord) {
  if (!row.attendanceStatus || !row.attendanceRecordedAt) return false;
  if (row.attendanceSource === 'AUTO_DEADLINE') {
    return row.attendanceRecordedAt >= activity.endsAt;
  }
  return (
    (!row.attendanceSource || row.attendanceSource === 'ORGANIZER') &&
    row.attendanceRecordedAt >= activity.startsAt &&
    row.attendanceRecordedAt < activity.endsAt
  );
}
