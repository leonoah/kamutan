# ADR-0002: רישוי פענוח — pypdfium2 במקום PyMuPDF; DWG דרך LibreDWG כ-CLI מבודד (מול ODA)

- **סטטוס:** PDF — **התקבל**. DWG — **ממתין להחלטת בעלים + ייעוץ משפטי** (יעד: סוף ספרינט 1)
- **תאריך:** 2026-10-11
- **מקורות:** 08_workplan_v2 §2 (הכרעות 1–2), review_consistency (סתירה 2), 04_architecture (סיכונים 2, 13), 06_security (SEC-17, SEC-18)

## הקשר

- **PyMuPDF/MuPDF מופץ תחת AGPL-3.0.** שימוש בו בשירות SaaS בלי רישיון מסחרי מ-Artifex מחייב פרסום קוד המקור של כל השירות. המסמכים המקוריים בחרו בו כליבת הקליטה, באותו מסמך שפסל את Ultralytics בגלל AGPL.
- **DWG:** הקבצים מגיעים מ-AutoCAD. החלופות: **LibreDWG** (GPL-3.0) או **ODA File Converter / Teigha** (קנייני, חברות בתשלום, רישיון שמגביל שימוש בשרת).
- פענוח קבצים עוינים בספריות C/C++ הוא משטח תקיפה (RCE/DoS) — כל parser רץ ב-sandbox (SEC-17).

## אפשרויות

| | PDF | DWG |
| --- | --- | --- |
| א | PyMuPDF + רישיון Artifex | ODA בתשלום |
| ב | **pypdfium2** (Apache-2.0 / BSD-3, PDFium של Google) | **LibreDWG** כ-CLI (`dwg2dxf`) בתהליך נפרד, בלי linking |
| ג | pdfminer/pdfplumber (MIT, איטי, בלי רסטר) | לא לתמוך ב-DWG; לבקש DXF/PDF |

## החלטה

1. **PDF: pypdfium2** לרינדור ולחילוץ נתיבים וטקסט. PyMuPDF **אסור** (חוק Semgrep `kamutan-no-pymupdf` חוסם `import fitz`/`pymupdf`). חזרה ל-PyMuPDF רק אחרי רכישת רישיון מסחרי ו-ADR חדש.
2. **DWG (ברירת מחדל ל-MVP, ממתין לאישור משפטי):** LibreDWG רץ **רק כתהליך CLI נפרד** בתוך ה-sandbox של הפענוח (ללא רשת, non-root, מגבלות CPU/זיכרון), מקבל קובץ מקומי ומחזיר DXF שנקרא ב-ezdxf (MIT). אין import, ctypes או cffi לספרייה (חוק `kamutan-no-libredwg-linking`). הבינארי נבנה מקוד מקור בגרסה מקובעת בשלב build נפרד של ה-image, וקוד המקור של LibreDWG זמין לפי GPL.
3. **גיבוי:** אם DWG נכשל — הודעה למשתמש לבקש DXF או PDF.
4. **ODA** נשקל מחדש אם שיעור ה-DWG אצל השותפים גבוה, או אם הייעוץ המשפטי פוסל את LibreDWG. אם נבחר: הורדה מאתר היצרן בלבד עם checksum, ורץ באותו sandbox (SEC-18).

## השלכות

- (+) אין חשיפת AGPL לקוד שלנו; pypdfium2 מהיר ואיכותי לרסטר.
- (−) pypdfium2 נותן API נמוך יותר לחילוץ נתיבים — יש לכתוב שכבת חילוץ גאומטריה משלנו (עבודת ספרינט 1).
- (−) **פתוח משפטית:** האם הרצת בינארי GPL כ-subprocess בשרת (בלי הפצה) היא "aggregate" — דעת עו"ד נדרשת לפני הבטא. החלטת בעלים: LibreDWG / ODA / ללא DWG.
- (−) LibreDWG פחות שלם מ-ODA בגרסאות DWG חדשות; נמדד ב-benchmark.
- כל תלות חדשה עוברת בדיקת רישיון ב-PR (צ'קליסט PR). רק Apache/MIT/BSD/MPL בקוד מקושר.
