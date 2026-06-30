#!/usr/bin/env python3
"""
Convert AXIS official content (exam questions/new_files_check) → seed CSVs,
then optionally run prisma/seed-questions-csv.ts.

Does NOT modify exam engine / frontend code — data pipeline only.
AXIS-H / AXIS-C keep existing legacy CSVs (unchanged).
"""

import csv
import glob
import html
import json
import os
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONTENT_ROOT = ROOT / "exam questions/new_files_check/3_AXIS_시리즈_출제/1_AXIS"
QUESTIONS_DIR = ROOT / "axis-backend/questions"

MCQ_HEADER = [
    "no", "cert_type", "level", "subject", "domain_area", "q_type", "item_purpose",
    "difficulty", "content", "option_a", "option_b", "option_c", "option_d",
    "correct_answer", "points", "explanation", "source_ref", "shuffle_exempt",
    "review_status", "review_comment", "version", "created_by", "created_date",
]

PRAC_HEADER = [
    "set_no", "cert_type", "level", "task_type", "task_title", "time_limit",
    "scenario_content", "sample_data", "required_structure", "forbidden_rules",
    "ai_tool_allowed", "rubric", "max_score", "model_answer", "risk_criteria",
    "benchmark_excellent", "benchmark_normal", "benchmark_borderline", "benchmark_fail",
    "ai_prompt_version", "review_status", "review_comment", "version", "created_by",
    "created_date",
]

DIFF_MAP = {"하": "easy", "중": "medium", "상": "hard", "최상": "hard", "easy": "easy", "medium": "medium", "hard": "hard"}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        t = data.strip()
        if t:
            self.parts.append(t)

    def text(self):
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def strip_html(raw):
    p = _TextExtractor()
    p.feed(raw)
    return html.unescape(p.text())


def csv_escape_row(row, fields):
    out = []
    for f in fields:
        v = row.get(f, "")
        if v is None:
            v = ""
        out.append(str(v))
    return out


def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, quoting=csv.QUOTE_MINIMAL)
        w.writerow(fields)
        for r in rows:
            w.writerow(csv_escape_row(r, fields))
    print(f"  wrote {path.name}: {len(rows)} rows")


def split_l3_options(opt_cell):
    text = strip_html(opt_cell)
    opts = {}
    for m in re.finditer(r"([A-D])\.\s*", text):
        key = m.group(1)
        start = m.end()
        nxt = re.search(r"[A-D]\.\s*", text[start:])
        end = start + nxt.start() if nxt else len(text)
        opts[key] = text[start:end].strip()
    return opts


def parse_l3_mcq_html(path):
    raw = path.read_text(encoding="utf-8")
    chunks = re.split(r'<table class="band">', raw)[1:]
    items = []
    for chunk in chunks:
        seq_m = re.search(r"연번\s*(\d+)", chunk)
        if not seq_m:
            continue
        no = int(seq_m.group(1))
        item_id = ""
        subject = ""
        domain = ""
        q_type = ""
        difficulty = ""
        id_m = re.search(r"<th>문항ID</th><td>([^<]+)</td>", chunk)
        if id_m:
            item_id = strip_html(id_m.group(1))
        subj_m = re.search(r"<th>평가영역</th><td>([^<]+)</td>", chunk)
        if subj_m:
            subject = strip_html(subj_m.group(1))
        type_m = re.search(r"<th>문항유형</th><td>([^<]+)</td>", chunk)
        if type_m:
            domain = strip_html(type_m.group(1))
            q_type = domain
        diff_m = re.search(r"<th>난이도</th><td>([^<]+)</td>", chunk)
        if diff_m:
            difficulty = DIFF_MAP.get(strip_html(diff_m.group(1)), "medium")
        stem_m = re.search(r'<tr class="s"><th>문제</th><td[^>]*>(.*?)</td></tr>', chunk, re.S)
        stem = strip_html(stem_m.group(1)) if stem_m else ""
        opt_m = re.search(r'<tr class="o"><th>보기</th><td[^>]*>(.*?)</td></tr>', chunk, re.S)
        opts = split_l3_options(opt_m.group(1)) if opt_m else {}
        ans_m = re.search(r'<tr class="a"><th>정답</th><td[^>]*>([A-D])</td>', chunk)
        answer = ans_m.group(1) if ans_m else "A"
        pts_m = re.search(r"<th[^>]*>배점</th><td>([0-9.]+)</td>", chunk)
        points = int(round(float(pts_m.group(1)))) if pts_m else 2
        expl_m = re.search(r'<tr class="e"><th>해설</th><td[^>]*>(.*?)</td></tr>', chunk, re.S)
        explanation = strip_html(expl_m.group(1)) if expl_m else ""
        items.append({
            "no": no,
            "cert_type": "AXIS",
            "level": "L3",
            "subject": subject or "AXIS L3",
            "domain_area": domain,
            "q_type": q_type or "multiple_choice",
            "item_purpose": "case_judgment",
            "difficulty": difficulty,
            "content": stem,
            "option_a": opts.get("A", ""),
            "option_b": opts.get("B", ""),
            "option_c": opts.get("C", ""),
            "option_d": opts.get("D", ""),
            "correct_answer": answer,
            "points": points,
            "explanation": explanation,
            "source_ref": item_id,
            "shuffle_exempt": "False",
            "review_status": "approved",
            "review_comment": f"import:{path.name}",
            "version": "2",
            "created_by": "",
            "created_date": "",
        })
    return items


def parse_l2_mcq_html(path, start_no):
    raw = path.read_text(encoding="utf-8")
    chunks = re.split(r'<div class="qbox">', raw)[1:]
    items = []
    no = start_no
    for chunk in chunks:
        head_m = re.search(r'class="qhead">([^<]+)</div>', chunk)
        item_id = ""
        if head_m:
            id_part = head_m.group(1)
            id_m2 = re.search(r"AXIS-L2-[A-Z0-9-]+", id_part)
            item_id = id_m2.group(0) if id_m2 else strip_html(id_part)
        subject_m = re.search(r"<th>평가영역</th><td>([^<]+)</td>", chunk)
        subject = strip_html(subject_m.group(1)) if subject_m else "AXIS L2"
        type_m = re.search(r"<th>문항유형</th><td>([^<]+)</td>", chunk)
        domain = strip_html(type_m.group(1)) if type_m else ""
        diff_m = re.search(r"<th>난이도</th><td>([^<]+)</td>", chunk)
        difficulty = DIFF_MAP.get(strip_html(diff_m.group(1)), "medium") if diff_m else "medium"
        stem_m = re.search(r'<div class="section"><div class="stem">문제</div>(.*?)</div>', chunk, re.S)
        if not stem_m:
            stem_m = re.search(r'<div class="stem">문제</div>(.*?)</div>', chunk, re.S)
        stem = strip_html(stem_m.group(1)) if stem_m else ""
        opts = {}
        for li in re.findall(r"<li>([A-D])\.\s*(.*?)</li>", chunk, re.S):
            opts[li[0]] = strip_html(li[1])
        ans_m = re.search(r'<div class="answer">정답:\s*([A-D])', chunk)
        answer = ans_m.group(1) if ans_m else "A"
        pts_m = re.search(r"배점:\s*([0-9.]+)", chunk)
        points = int(round(float(pts_m.group(1)))) if pts_m else 4
        expl_m = re.search(r'<div class="expl">(.*?)</div>', chunk, re.S)
        explanation = strip_html(expl_m.group(1)) if expl_m else ""
        items.append({
            "no": no,
            "cert_type": "AXIS",
            "level": "L2",
            "subject": subject,
            "domain_area": domain,
            "q_type": domain or "multiple_choice",
            "item_purpose": "tool_use",
            "difficulty": difficulty,
            "content": stem,
            "option_a": opts.get("A", ""),
            "option_b": opts.get("B", ""),
            "option_c": opts.get("C", ""),
            "option_d": opts.get("D", ""),
            "points": points,
            "explanation": explanation,
            "source_ref": item_id,
            "shuffle_exempt": "False",
            "review_status": "approved",
            "review_comment": f"import:{path.name}",
            "version": "2",
            "created_by": "",
            "created_date": "",
        })
        no += 1
    return items, no


def parse_l1_mcq_yaml(paths):
    items = []
    no = 1
    for path in sorted(paths):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        for it in data.get("items", []):
            opts = it.get("options", {})
            expl = it.get("explanation", "")
            if isinstance(expl, dict):
                expl = json.dumps(expl, ensure_ascii=False)
            items.append({
                "no": no,
                "cert_type": "AXIS",
                "level": "L1",
                "subject": it.get("evaluation_area") or it.get("item_type") or "AXIS L1",
                "domain_area": it.get("item_type", ""),
                "q_type": it.get("item_type", "multiple_choice"),
                "item_purpose": "case_judgment",
                "difficulty": DIFF_MAP.get(str(it.get("difficulty", "중")), "medium"),
                "content": it.get("stem", ""),
                "option_a": opts.get("A", ""),
                "option_b": opts.get("B", ""),
                "option_c": opts.get("C", ""),
                "option_d": opts.get("D", ""),
                "correct_answer": str(it.get("answer", "A")).strip().upper()[:1],
                "points": 3,
                "explanation": str(expl),
                "source_ref": it.get("item_id", ""),
                "shuffle_exempt": "False",
                "review_status": "approved",
                "review_comment": f"import:{path.name}",
                "version": "2",
                "created_by": "",
                "created_date": "",
            })
            no += 1
    return items


def rubric_from_dict(rubric):
    if isinstance(rubric, dict):
        parts = [f"{k}({v})" for k, v in rubric.items()]
        return " | ".join(parts)
    if isinstance(rubric, list):
        parts = []
        for r in rubric:
            if isinstance(r, dict):
                parts.append(f"{r.get('criteria', '')}({r.get('points', '')}): {r.get('description', '')}")
        return " | ".join(parts)
    return str(rubric or "")


def pick_anchor_benchmarks(anchor_doc):
    out = {"benchmark_excellent": "", "benchmark_normal": "", "benchmark_borderline": "", "benchmark_fail": ""}
    for a in anchor_doc.get("anchor_answers", []):
        band = str(a.get("band", "")).lower()
        text = a.get("full_anchor_response") or a.get("answer_summary") or ""
        if band == "excellent":
            out["benchmark_excellent"] = str(text)[:8000]
        elif band == "normal":
            out["benchmark_normal"] = str(text)[:8000]
        elif band == "borderline":
            out["benchmark_borderline"] = str(text)[:8000]
        elif band == "fail":
            out["benchmark_fail"] = str(text)[:8000]
    return out


def parse_l2_practical_yaml(paths):
    rows = []
    for path in sorted(paths):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        set_m = re.search(r"SET-?0*(\d+)", str(data.get("scenario_set_id", path.name)))
        set_no = int(set_m.group(1)) if set_m else 0
        if set_no <= 0:
            continue
        materials = data.get("provided_materials", {})
        sample_lines = []
        if isinstance(materials, dict):
            for k, v in materials.items():
                sample_lines.append(f"{k}: {v}" if not str(k).startswith("-") else str(v))
        elif isinstance(materials, list):
            sample_lines = [str(x) for x in materials]
        sample_data = "\n".join(sample_lines)[:12000]
        scenario = data.get("scenario_context", "")
        ai_env = data.get("allowed_ai_environment", {})
        ai_allowed = ai_env.get("tool", "시험 시스템 내장 AI") if isinstance(ai_env, dict) else "시험 시스템 내장 AI"
        for task in data.get("tasks", []):
            tid = str(task.get("task_id", ""))
            suffix = tid.split("-")[-1] if tid else "A"
            task_type = {"A": "task_a", "B": "task_b", "C": "task_c"}.get(suffix, f"task_{suffix.lower()}")
            model_elems = task.get("model_answer_elements", [])
            model_answer = "\n".join(str(x) for x in model_elems) if isinstance(model_elems, list) else str(model_elems)
            risk = task.get("risk_flags", [])
            risk_criteria = "; ".join(str(x) for x in risk) if isinstance(risk, list) else str(risk)
            time_m = re.search(r"(\d+)", str(task.get("time_recommendation", "20")))
            time_limit = int(time_m.group(1)) if time_m else 20
            rows.append({
                "set_no": set_no,
                "cert_type": "AXIS",
                "level": "L2",
                "task_type": task_type,
                "task_title": task.get("practice_type", data.get("scenario_title", "실습")),
                "time_limit": time_limit,
                "scenario_content": f"{scenario}\n\n{task.get('task_prompt', '')}".strip(),
                "sample_data": sample_data,
                "required_structure": "\n".join(task.get("required_submission", [])) if isinstance(task.get("required_submission"), list) else "",
                "forbidden_rules": "개인정보 입력 금지, 외부 AI 사용 금지, 타인 답안 참조 금지",
                "ai_tool_allowed": ai_allowed,
                "rubric": rubric_from_dict(task.get("rubric")),
                "max_score": int(task.get("points", 20)),
                "model_answer": model_answer,
                "risk_criteria": risk_criteria,
                "benchmark_excellent": model_answer[:2000],
                "benchmark_normal": "",
                "benchmark_borderline": "",
                "benchmark_fail": "",
                "ai_prompt_version": "v1.1",
                "review_status": "approved",
                "review_comment": f"import:{path.name}",
                "version": "2",
                "created_by": "",
                "created_date": "",
            })
    return rows


def parse_l1_practical(content_root, essay_paths):
    scen_dirs = sorted(glob.glob(str(content_root / "1_AXIS L1/AXIS L1 실행계획 평가 출제/**/AXIS_L1_PartB_SCEN*_응시자배포본*.html"), recursive=True))
    scen_html = {}
    scen_anchor = {}
    for f in scen_dirs:
        base = os.path.basename(f)
        m = re.search(r"SCEN(\d+)", base)
        if not m:
            continue
        scen_html[int(m.group(1))] = Path(f)
    for f in glob.glob(str(content_root / "1_AXIS L1/AXIS L1 실행계획 평가 출제/**/AXIS_L1_PartB_SCEN*_앵커답안*.yaml"), recursive=True):
        base = os.path.basename(f)
        m = re.search(r"SCEN(\d+)", base)
        if m:
            scen_anchor[int(m.group(1))] = yaml.safe_load(Path(f).read_text(encoding="utf-8"))

    essays = []
    for p in sorted(essay_paths):
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
        essays.extend(data.get("items", []))

    rows = []
    set_nos = sorted(scen_html.keys())
    for i, set_no in enumerate(set_nos):
        html_path = scen_html[set_no]
        scenario_text = strip_html(html_path.read_text(encoding="utf-8"))[:12000]
        anchors = pick_anchor_benchmarks(scen_anchor.get(set_no, {}))
        rows.append({
            "set_no": set_no,
            "cert_type": "AXIS",
            "level": "L1",
            "task_type": "part_a",
            "task_title": "AX 실행계획서",
            "time_limit": 60,
            "scenario_content": scenario_text,
            "sample_data": "",
            "required_structure": "실행계획서 10개 항목 템플릿 준수",
            "forbidden_rules": "개인정보 입력 금지, 외부 AI 사용 금지(LMS만), 타인 답안 참조 금지",
            "ai_tool_allowed": "LMS 내장 AI",
            "rubric": "R1-R8 루브릭 (총 55점)",
            "max_score": 55,
            "model_answer": anchors.get("benchmark_excellent", ""),
            "risk_criteria": "허위 수치, 비현실적 ROI, 개인정보 포함",
            **anchors,
            "ai_prompt_version": "v1.1",
            "review_status": "approved",
            "review_comment": f"import:SCEN{set_no:03d}",
            "version": "2",
            "created_by": "",
            "created_date": "",
        })
        e1 = essays[(i * 2) % len(essays)] if essays else {}
        e2 = essays[(i * 2 + 1) % len(essays)] if essays else {}
        for task_type, essay, title_suffix in [
            ("part_b", e1, "서술형 1"),
            ("essay_2", e2, "서술형 2"),
        ]:
            if not essay:
                continue
            scenario = f"{essay.get('scenario', '')}\n\n{essay.get('question', '')}".strip()
            rubric = rubric_from_dict(essay.get("rubric"))
            outline = essay.get("excellent_answer_outline", [])
            outline_text = "\n".join(str(x) for x in outline) if isinstance(outline, list) else str(outline)
            fail_patterns = essay.get("critical_fail_patterns", [])
            fail_text = "\n".join(str(x) for x in fail_patterns) if isinstance(fail_patterns, list) else str(fail_patterns)
            rows.append({
                "set_no": set_no,
                "cert_type": "AXIS",
                "level": "L1",
                "task_type": task_type,
                "task_title": f"시나리오 {title_suffix}",
                "time_limit": 30,
                "scenario_content": scenario,
                "sample_data": "",
                "required_structure": "서술형 답안",
                "forbidden_rules": "개인정보 입력 금지, 외부 AI 사용 금지(LMS만), 타인 답안 참조 금지",
                "ai_tool_allowed": "AI 사용 불가",
                "rubric": rubric,
                "max_score": int(essay.get("score", 10)),
                "model_answer": outline_text,
                "risk_criteria": fail_text,
                "benchmark_excellent": outline_text[:4000],
                "benchmark_normal": "",
                "benchmark_borderline": "",
                "benchmark_fail": fail_text[:2000],
                "ai_prompt_version": "v1.1",
                "review_status": "approved",
                "review_comment": essay.get("item_id", ""),
                "version": "2",
                "created_by": "",
                "created_date": "",
            })
    return rows


def parse_l3_practical_html(paths):
    rows = []
    type_map = {
        "현업적용형": "l3_apply",
        "지시설계형": "l3_prompt",
        "분석검증형": "l3_verify",
        "리스크판단형": "l3_risk",
    }
    for path in sorted(paths):
        raw = path.read_text(encoding="utf-8")
        type_key = next((k for k in type_map if k in path.name), "l3_practical")
        task_type = type_map.get(type_key, "l3_practical")
        chunks = re.split(r'<section class="item">', raw)[1:]
        for chunk in chunks:
            id_m = re.search(r"<th>문항ID</th><td>([^<]+)</td>", chunk)
            item_id = strip_html(id_m.group(1)) if id_m else ""
            num_m = re.search(r"AXIS-L3-P-(\d+)", item_id)
            set_no = int(num_m.group(1)) if num_m else len(rows) + 1
            h2_m = re.search(r"<h2>([^<]+)</h2>", chunk)
            title = strip_html(h2_m.group(1)) if h2_m else "L3 실습형"
            scen_m = re.search(r"<h3>1\) 고정 시나리오</h3>\s*<div class=\"box\">(.*?)</div>", chunk, re.S)
            task_m = re.search(r"<h3>2\) 응시자 과업</h3>\s*<div class=\"box\">(.*?)</div>", chunk, re.S)
            scenario = strip_html(scen_m.group(1)) if scen_m else ""
            task = strip_html(task_m.group(1)) if task_m else ""
            answer_m = re.search(r"<h3>4\) 정답키</h3>\s*<table class=\"subtable\">(.*?)</table>", chunk, re.S)
            model_answer = strip_html(answer_m.group(1)) if answer_m else ""
            rubric_m = re.search(r"<h3>5\) 유형별 10점 루브릭</h3>\s*<table>(.*?)</table>", chunk, re.S)
            rubric = strip_html(rubric_m.group(1)) if rubric_m else ""
            risk_m = re.search(r"<th>위험 플래그</th><td>(.*?)</td>", chunk, re.S)
            risk = strip_html(risk_m.group(1)) if risk_m else ""
            pts_m = re.search(r"<th>배점</th><td>(\d+)</td>", chunk)
            points = int(pts_m.group(1)) if pts_m else 10
            time_m = re.search(r"<th>시간</th><td>(\d+)", chunk)
            time_limit = int(time_m.group(1)) if time_m else 5
            rows.append({
                "set_no": set_no,
                "cert_type": "AXIS",
                "level": "L3",
                "task_type": task_type,
                "task_title": title,
                "time_limit": time_limit,
                "scenario_content": f"{scenario}\n\n[과업] {task}".strip(),
                "sample_data": "",
                "required_structure": "선택형 + 짧은 근거 서술",
                "forbidden_rules": "개인정보 입력 금지, 외부 AI 사용 금지",
                "ai_tool_allowed": "LMS 내장 AI",
                "rubric": rubric,
                "max_score": points,
                "model_answer": model_answer,
                "risk_criteria": risk,
                "benchmark_excellent": model_answer[:2000],
                "benchmark_normal": "",
                "benchmark_borderline": "",
                "benchmark_fail": "",
                "ai_prompt_version": "v1.1",
                "review_status": "approved",
                "review_comment": item_id,
                "version": "2",
                "created_by": "",
                "created_date": "",
            })
    return rows


def remove_superseded_axis_mcq():
    for old in ["AXIS_L3_200.csv", "AXIS_L2_120.csv", "AXIS_L1_100.csv"]:
        p = QUESTIONS_DIR / old
        if p.exists():
            p.unlink()
            print(f"  removed superseded {old}")


def main():
    print("AXIS new content → CSV converter\n" + "=" * 50)
    if not CONTENT_ROOT.exists():
        print(f"Missing content root: {CONTENT_ROOT}", file=sys.stderr)
        return 1

    # L3 MCQ (400)
    l3_mc = []
    for f in sorted(glob.glob(str(CONTENT_ROOT / "3_AXIS L3/AXIS_L3_객관식 400문항/*.html"))):
        if "통합" in f or "정답" in f or "(1)" in f:
            continue
        l3_mc.extend(parse_l3_mcq_html(Path(f)))
    l3_mc.sort(key=lambda x: x["no"])
    # Deduplicate by question number (safety)
    seen = set()
    deduped = []
    for q in l3_mc:
        if q["no"] in seen:
            continue
        seen.add(q["no"])
        deduped.append(q)
    l3_mc = deduped
    print(f"L3 MCQ parsed: {len(l3_mc)}")

    # L2 MCQ (300)
    l2_mc = []
    no = 1
    for f in sorted(glob.glob(str(CONTENT_ROOT / "2_AXIS L2/AXIS L2 객관식 평가 출제/*.html"))):
        batch, no = parse_l2_mcq_html(Path(f), no)
        l2_mc.extend(batch)
    print(f"L2 MCQ parsed: {len(l2_mc)}")

    # L1 MCQ (250)
    l1_yaml = glob.glob(str(CONTENT_ROOT / "1_AXIS L1/AXIS L1 객관식 평가 출제/**/AXIS L1 Leader*.yaml"), recursive=True)
    l1_mc = parse_l1_mcq_yaml([Path(p) for p in l1_yaml])
    print(f"L1 MCQ parsed: {len(l1_mc)}")

    # L2 practical (20 sets)
    l2_yaml = glob.glob(str(CONTENT_ROOT / "2_AXIS L2/AXIS L2 실습형 평가 출제/**/AXIS_L2_실습형_SET*.yaml"), recursive=True)
    l2_pr = parse_l2_practical_yaml([Path(p) for p in l2_yaml])
    print(f"L2 practical parsed: {len(l2_pr)}")

    # L1 practical (20 sets × 3)
    essay_yaml = glob.glob(str(CONTENT_ROOT / "1_AXIS L1/AXIS L1 서술형 평가 출제/**/AXIS_L1_서술형*.yaml"), recursive=True)
    l1_pr = parse_l1_practical(CONTENT_ROOT, [Path(p) for p in essay_yaml if "연번" not in p])
    print(f"L1 practical parsed: {len(l1_pr)}")

    # L3 practical (80)
    l3_pr_files = glob.glob(str(CONTENT_ROOT / "3_AXIS L3/AXIS_L3_실습형 80문항/*.html"))
    l3_pr = parse_l3_practical_html([Path(p) for p in l3_pr_files])
    print(f"L3 practical parsed: {len(l3_pr)}")

    print("\nWriting CSV files…")
    remove_superseded_axis_mcq()
    write_csv(QUESTIONS_DIR / "AXIS_L3_400.csv", MCQ_HEADER, l3_mc)
    write_csv(QUESTIONS_DIR / "AXIS_L2_300.csv", MCQ_HEADER, l2_mc)
    write_csv(QUESTIONS_DIR / "AXIS_L1_250.csv", MCQ_HEADER, l1_mc)
    write_csv(QUESTIONS_DIR / "AXIS_L2_실기.csv", PRAC_HEADER, l2_pr)
    write_csv(QUESTIONS_DIR / "AXIS_L1_실기.csv", PRAC_HEADER, l1_pr)
    write_csv(QUESTIONS_DIR / "AXIS_L3_실기.csv", PRAC_HEADER, l3_pr)

    if "--no-seed" in sys.argv:
        print("\nSkipping DB seed (--no-seed).")
        return 0

    print("\nSeeding database…")
    backend = ROOT / "axis-backend"
    r = subprocess.run(
        ["npm", "run", "db:seed:questions"],
        cwd=backend,
        check=False,
    )
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
