from kamutan_drawing.ocr.textutil import cer_counts, levenshtein, normalize, visual_to_logical


def test_visual_to_logical_hebrew_and_numbers():
    assert visual_to_logical("םולש") == "שלום"
    assert visual_to_logical("1:50") == "1:50"
    assert visual_to_logical("H=120 ןותחת הבוג") == "גובה תחתון H=120"
    assert visual_to_logical(":ךיראת") == "תאריך:"
    assert visual_to_logical("22.12.16") == "22.12.16"
    assert visual_to_logical("תורונ 2-ל לצפתמ") == "מתפצל ל-2 נורות"
    assert visual_to_logical('מ"מ 50 הרבוק') == 'קוברה 50 מ"מ'


def test_normalize_and_cer():
    assert normalize("מ״מ") == 'מ"מ'
    assert normalize("נק’") == "נק'"
    assert normalize("  a   b ") == "a b"
    assert levenshtein("kitten", "sitting") == 3
    assert cer_counts("שקע כח", "שקע כח") == (0, 6)
    assert cer_counts("שקע כח", "שקע בח") == (1, 6)
