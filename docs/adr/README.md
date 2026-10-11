# Architecture Decision Records

פורמט: [MADR](https://adr.github.io/madr/) מקוצר, בעברית. כל ADR חדש או שינוי סטטוס דורש אישור אנושי (CODEOWNERS).
מקור סמכות: כשמסמכי האפיון סותרים, **08_workplan_v2.md §2** קובע, וה-ADR מתעד את ההכרעה.

| # | כותרת | סטטוס |
| --- | --- | --- |
| [0001](0001-hybrid-stack.md) | סטאק היברידי: React/Vercel + NestJS + Python workers + Supabase EU | התקבל |
| [0002](0002-pdf-dwg-licensing.md) | רישוי פענוח: pypdfium2 במקום PyMuPDF; DWG דרך LibreDWG כ-CLI מבודד מול ODA | התקבל (PDF) / ממתין (DWG) |
| [0003](0003-worker-db-role.md) | role ייעודי ומוגבל ל-worker, לא service_role | התקבל |
| [0004](0004-confidence-definition.md) | הגדרת ביטחון: תאי כיול לכל class, Wilson ≥98%, שורה = מינימום | התקבל |
| [0005](0005-share-links-via-api.md) | קישורי שיתוף רק דרך ה-API | התקבל |
| [0006](0006-coordinates-paper-mm.md) | קואורדינטות: מ"מ על הנייר, y כלפי מטה | התקבל |
| [0007](0007-llm-gateway-policy.md) | מדיניות LLM gateway | התקבל |

תבנית: העתיקו קובץ קיים ושמרו על הסעיפים: סטטוס, הקשר, אפשרויות, החלטה, השלכות.
