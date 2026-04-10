/**
 * Message Repository — robot_messages + work_records database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface RobotMessageRow {
  id: number;
  message_id: string;
  user_id: string;
  equipment_id: string | null;
  robot_msg: string;
  robot_msg_date: string;
  robot_msg_unread: number;
}

export interface WorkRecordRow {
  id: number;
  record_id: string;
  user_id: string;
  equipment_id: string | null;
  work_record_date: string;
  work_status: string | null;
  work_time: number | null;
  work_record_unread: number;
  work_area_m2: number | null;
  cut_grass_height: number | null;
  map_names: string | null;
  start_way: string | null;
  schedule_id: string | null;
  week: string | null;
  date_time: string | null;
}

export class MessageRepository {
  // ── Robot messages — prepared statements ──

  private _findMessagesByUserId = db.prepare(
    'SELECT * FROM robot_messages WHERE user_id = ? ORDER BY robot_msg_date DESC LIMIT ? OFFSET ?'
  );
  private _countMessages = db.prepare(
    'SELECT COUNT(*) as c FROM robot_messages WHERE user_id = ?'
  );
  private _countUnreadMessages = db.prepare(
    'SELECT COUNT(*) as c FROM robot_messages WHERE user_id = ? AND robot_msg_unread = 1'
  );
  private _getLatestMessage = db.prepare(
    'SELECT robot_msg_date FROM robot_messages WHERE user_id = ? ORDER BY robot_msg_date DESC LIMIT 1'
  );
  private _markMessagesRead = db.prepare(
    'UPDATE robot_messages SET robot_msg_unread = 0 WHERE user_id = ?'
  );
  private _createMessage = db.prepare(`
    INSERT INTO robot_messages (message_id, user_id, equipment_id, robot_msg, robot_msg_date, robot_msg_unread)
    VALUES (?, ?, ?, ?, datetime('now'), 1)
  `);
  private _createMessageWithMsg = db.prepare(`
    INSERT INTO robot_messages (message_id, user_id, equipment_id, robot_msg)
    VALUES (?, ?, ?, ?)
  `);
  private _deleteMessagesByUserId = db.prepare(
    'DELETE FROM robot_messages WHERE user_id = ?'
  );

  // ── Work records — prepared statements ──

  private _findWorkRecordsByUserId = db.prepare(
    'SELECT * FROM work_records WHERE user_id = ? ORDER BY work_record_date DESC LIMIT ? OFFSET ?'
  );
  private _countWorkRecords = db.prepare(
    'SELECT COUNT(*) as c FROM work_records WHERE user_id = ?'
  );
  private _countUnreadWorkRecords = db.prepare(
    'SELECT COUNT(*) as c FROM work_records WHERE user_id = ? AND work_record_unread = 1'
  );
  private _getLatestWorkRecord = db.prepare(
    'SELECT work_record_date FROM work_records WHERE user_id = ? ORDER BY work_record_date DESC LIMIT 1'
  );
  private _markWorkRecordsRead = db.prepare(
    'UPDATE work_records SET work_record_unread = 0 WHERE user_id = ?'
  );
  private _createWorkRecord = db.prepare(`
    INSERT INTO work_records (record_id, user_id, equipment_id, work_record_date, work_status, work_time, work_record_unread)
    VALUES (?, ?, ?, datetime('now'), ?, ?, 1)
  `);
  private _createWorkRecordFull = db.prepare(`
    INSERT INTO work_records
      (record_id, user_id, equipment_id, date_time, work_time, work_area_m2,
       cut_grass_height, map_names, start_way, work_status, schedule_id, week,
       work_record_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `);
  private _countWorkRecordsBySchedule = db.prepare(
    'SELECT COUNT(*) as cnt FROM work_records WHERE schedule_id = ?'
  );

  // ── Robot messages — methods ──

  findMessagesByUserId(userId: string, limit: number, offset: number): RobotMessageRow[] {
    return this._findMessagesByUserId.all(userId, limit, offset) as RobotMessageRow[];
  }

  countMessages(userId: string): number {
    return (this._countMessages.get(userId) as { c: number }).c;
  }

  countUnreadMessages(userId: string): number {
    return (this._countUnreadMessages.get(userId) as { c: number }).c;
  }

  getLatestMessageDate(userId: string): string | null {
    const row = this._getLatestMessage.get(userId) as { robot_msg_date: string } | undefined;
    return row?.robot_msg_date ?? null;
  }

  markMessagesRead(userId: string): void {
    this._markMessagesRead.run(userId);
  }

  markMessagesReadByIds(messageIds: string[], userId: string): void {
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`UPDATE robot_messages SET robot_msg_unread = 0 WHERE message_id IN (${placeholders}) AND user_id = ?`)
      .run(...messageIds, userId);
  }

  createMessage(messageId: string, userId: string, equipmentId: string, msg: string): void {
    this._createMessage.run(messageId, userId, equipmentId, msg);
  }

  createMessageRaw(messageId: string, userId: string, equipmentId: string, msg: string): void {
    this._createMessageWithMsg.run(messageId, userId, equipmentId, msg);
  }

  deleteMessagesByUserId(userId: string): void {
    this._deleteMessagesByUserId.run(userId);
  }

  deleteMessagesByIds(messageIds: string[], userId: string): void {
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM robot_messages WHERE message_id IN (${placeholders}) AND user_id = ?`)
      .run(...messageIds, userId);
  }

  // ── Work records — methods ──

  findWorkRecordsByUserId(userId: string, limit: number, offset: number): WorkRecordRow[] {
    return this._findWorkRecordsByUserId.all(userId, limit, offset) as WorkRecordRow[];
  }

  countWorkRecords(userId: string): number {
    return (this._countWorkRecords.get(userId) as { c: number }).c;
  }

  countUnreadWorkRecords(userId: string): number {
    return (this._countUnreadWorkRecords.get(userId) as { c: number }).c;
  }

  getLatestWorkRecordDate(userId: string): string | null {
    const row = this._getLatestWorkRecord.get(userId) as { work_record_date: string } | undefined;
    return row?.work_record_date ?? null;
  }

  markWorkRecordsRead(userId: string): void {
    this._markWorkRecordsRead.run(userId);
  }

  createWorkRecord(recordId: string, userId: string, equipmentId: string, status: string, workTime: number): void {
    this._createWorkRecord.run(recordId, userId, equipmentId, status, workTime);
  }

  createWorkRecordFull(
    recordId: string, userId: string, equipmentId: string,
    dateTime: string | null, workTime: number | null, workAreaM2: number | null,
    cutGrassHeight: number | null, mapNames: string | null, startWay: string | null,
    workStatus: string | null, scheduleId: string | null, week: string | null,
  ): void {
    this._createWorkRecordFull.run(
      recordId, userId, equipmentId,
      dateTime, workTime, workAreaM2,
      cutGrassHeight, mapNames, startWay,
      workStatus, scheduleId, week,
    );
  }

  countWorkRecordsBySchedule(scheduleId: string): number {
    return (this._countWorkRecordsBySchedule.get(scheduleId) as { cnt: number }).cnt;
  }
}

export const messageRepo = new MessageRepository();
