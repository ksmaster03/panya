// ตัวตรวจความลับ: ต้องจับของจริง และไม่จับข้อความทั่วไปหรือค่าตัวอย่าง
import { describe, expect, test } from 'bun:test'
import { findSecret } from '../src/secrets'

describe('จับความลับ', () => {
  const cases: [string, string][] = [
    ['AWS key AKIAIOSFODNN7EXAMPLE ใช้กับบัญชีหลัก', 'aws-access-key'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA', 'private-key'],
    ['token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab', 'github-token'],
    ['ใช้ sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 เรียก Claude', 'anthropic-key'],
    ['OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'openai-key'],
    ['maps key AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google-api-key'],
    ['postgres://admin:S3cretPass@db.example.com:5432/app', 'url-credentials'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstu', 'bearer-token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop', 'jwt'],
    ['panya key pk_AnxvwLTqhinHTWDtRbAVaUwJLhp88rvnvaj8RKu4', 'panya-api-key'],
    ['key ของผม pnu_abcdefgh2345_AbCdEfGhJkLmNpQrStUvWxYz23', 'panya-api-key'],
    ['รหัสผ่าน wifi คือ Home@2024!', 'credential-assignment'],
    ['password: hunter2xyz', 'credential-assignment'],
    ['DB_PASSWORD=Tr0ub4dor&3', 'credential-assignment'],
    ['api_key = "a8f3b2c1d4e5f6a7b8c9"', 'credential-assignment'],
  ]
  for (const [text, rule] of cases) test(rule + ': ' + text.slice(0, 30), () => expect(findSecret(text)?.rule).toBe(rule))
})

describe('ไม่จับข้อความทั่วไป', () => {
  const ok = [
    'ท่า D-07 ใช้ได้เฉพาะรถ 6 ล้อ',
    'ผู้ใช้ลืมรหัสผ่านให้กดปุ่มรีเซ็ตที่หน้า login',
    'password: required (อย่างน้อย 10 ตัว)',
    'ตั้งค่า PANYA_API_KEYS=<your-key> ใน .env',
    'api_key: ${API_KEY}',
    'password = process.env.DB_PASSWORD',
    'token: xxxxxxxx',
    'secret: ********',
    'รถยก FL-21 ส่งซ่อมแบตเตอรี่ วันที่ 2026-10-22',
    'ใช้ https://panya.toptierdigital.space/login เพื่อเข้าระบบ',
    'git commit f98b6d2 แก้หน้าแดชบอร์ด',
  ]
  for (const text of ok) test(text, () => expect(findSecret(text)).toBeNull())
})
