# 🗡️ Tale Engine — Solo AI Adventure (PWA)

เกม AI text-adventure ส่วนตัว เล่นคนเดียว ขับเคลื่อนด้วย **Google Gemini**
ติดตั้งเป็นแอปบน Android ได้ ข้อมูลทั้งหมดเก็บอยู่ในเครื่องคุณเท่านั้น

---

## ขั้นที่ 1 — ขอ Gemini API key (ฟรี, ~2 นาที)

1. เปิด **https://aistudio.google.com/apikey**
2. ล็อกอินด้วยบัญชี Google
3. กด **Create API key** → คัดลอกค่าที่ได้ (ขึ้นต้นด้วย `AIza…`)

> **หมายเหตุ:** Gemini API มี free tier แต่โควตาและเงื่อนไขเปลี่ยนได้เรื่อยๆ
> ควรดูหน้า pricing ปัจจุบันของ Google ก่อนใช้งานหนัก
> Claude Pro **ไม่ได้** ให้สิทธิ์ API นี้ — เป็นคนละระบบกัน

---

## ขั้นที่ 2 — เอาขึ้น GitHub Pages (ฟรี)

PWA **บังคับต้องใช้ HTTPS** จึงจะติดตั้งเป็นแอปได้ GitHub Pages ให้ HTTPS ฟรี

```bash
# 1. สร้าง repo ใหม่บน github.com ชื่อ tale-engine (เลือก Public)

# 2. ในโฟลเดอร์นี้
git init
git add .
git commit -m "Tale Engine PWA"
git branch -M main
git remote add origin https://github.com/<ชื่อผู้ใช้ของคุณ>/tale-engine.git
git push -u origin main
```

จากนั้นในหน้า repo บน GitHub:
**Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `(root)` → Save**

รอ 1-2 นาที จะได้ URL:
```
https://<ชื่อผู้ใช้>.github.io/tale-engine/
```

> ไฟล์ทั้งหมดใช้ path แบบ relative (`./`) จึงทำงานได้ทันทีในซับโฟลเดอร์
> ไม่ต้องแก้ config อะไรเพิ่ม

---

## ขั้นที่ 3 — ติดตั้งลง Android

1. เปิด URL ข้างบนด้วย **Chrome บน Android**
2. เมนู ⋮ → **Install app** (หรือ **Add to Home screen**)
3. จะได้ไอคอนบนหน้าจอ เปิดแล้วเต็มจอ ไม่มีแถบ browser

ครั้งแรกที่เปิด ให้กด ⚙️ **ตั้งค่า** → วาง API key → **🔌 ทดสอบการเชื่อมต่อ** → **บันทึก**

---

## (ทางเลือก) ขั้นที่ 4 — ทำเป็นไฟล์ APK จริง

ถ้าอยากได้ `.apk` ติดตั้งเอง หรือส่งขึ้น Play Store ใช้ **Bubblewrap** ของ Google
ห่อ PWA เป็น Android app ได้โดยไม่ต้องเขียน Java/Kotlin:

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://<ชื่อผู้ใช้>.github.io/tale-engine/manifest.json
bubblewrap build
```

ต้องมี JDK + Android SDK ติดตั้งไว้ (Bubblewrap จะช่วยดาวน์โหลดให้ตอน `init`)
ผลลัพธ์คือ `app-release-signed.apk`

---

## ฟีเจอร์

| ส่วน | รายละเอียด |
|---|---|
| **โหมดเล่น** | RPG (สกิล/ไอเทม) · Story (เน้นเนื้อเรื่อง) · D&D (ทอย d20 เห็นเลขจริง) |
| **ความจำ 3 ชั้น** | สถานะโลก (JSON) + บทสรุปรายตอน (บีบอัดอัตโนมัติ) + บทสนทนาสด |
| **แก้ไขได้ทุกอย่าง** | background ตัวละคร/โลก, HP, สกิล, ไอเทม, NPC, flags, บทสรุปความจำ |
| **หลายเกม** | บันทึกได้ไม่จำกัด สลับไปมาได้ |
| **ส่งออก** | Markdown, TXT, คัดลอก, และเซฟเต็ม JSON (ย้ายเครื่องได้) |
| **เทิร์น** | ลองใหม่, ย้อน 1 เทิร์น, หยุดกลางคัน |
| **ออฟไลน์** | ตัวแอปเปิดได้ออฟไลน์ (แต่การเล่นต้องต่อเน็ตเพื่อเรียก Gemini) |

---

## ความเป็นส่วนตัว

- **API key** เก็บใน IndexedDB ของเครื่องนี้เท่านั้น ไม่ถูกส่งไปที่ใดนอกจาก Google โดยตรง
- **เนื้อเรื่องทั้งหมด** เก็บในเครื่อง ไม่มีเซิร์ฟเวอร์ตัวกลาง
- Service worker **ไม่แคช** คำขอที่ส่งไป Gemini เลย
- ล้างข้อมูลเว็บไซต์ของ Chrome = ลบเซฟทั้งหมด → **สำรองด้วยปุ่ม 💾 ดาวน์โหลดเซฟเต็ม (.json) เป็นระยะ**

---

## โครงสร้างไฟล์

```
index.html      โครงหน้าจอทั้งหมด
styles.css      ธีม (รองรับโหมดมืด/สว่างอัตโนมัติ)
app.js          ตรรกะเกม, Gemini client, IndexedDB, ระบบความจำ
manifest.json   ข้อมูล PWA
sw.js           service worker (แคชเฉพาะตัวแอป)
icons/          ไอคอน 192/512/maskable
test.mjs        ชุดทดสอบหลัก 77 ข้อ
test-edge.mjs   ชุดทดสอบ edge case 50 ข้อ
```

รันเทสต์:
```bash
npm install
node test.mjs
node test-edge.mjs
```

---

## ปรับแต่งที่ใช้บ่อย (ใน `app.js` ด้านบนสุด)

| ค่า | ความหมาย | ค่าเริ่มต้น |
|---|---|---|
| `CTX_KEEP` | บทสนทนาดิบที่เก็บไว้เต็มๆ | 16 |
| `CTX_TRIGGER` | เกินเท่าไหร่จึงเริ่มบีบอัด | 24 |
| `CHAPTER_COMPRESS_AT` | บทสรุปสะสมกี่ตอนจึงรวบเป็น arc | 10 |
| `PROMPT_CHAR_BUDGET` | เพดานขนาด prompt (กันล็อกตาย) | 400000 |
| `DEFAULT_MODEL` | โมเดลเริ่มต้น (เปลี่ยนได้ในตั้งค่า → 🔄 โหลดรายชื่อโมเดล) | `gemini-flash-latest` |

ถ้าเนื้อเรื่องยังหลุดบริบท ลองเพิ่ม `CTX_KEEP` เป็น 24-32
(แลกกับค่า token ต่อเทิร์นที่สูงขึ้น)
