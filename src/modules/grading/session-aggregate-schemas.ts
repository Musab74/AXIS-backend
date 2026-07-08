/**
 * v2.0 session-aggregate JSON Schemas (draft-07), embedded VERBATIM from the
 * official standard documents so the aggregation service can validate without
 * build-time asset copying. Source of truth:
 *   new_doc_l3/1_AXIS L1/4_채점/AXIS_L1_채점_세션집계_JSON스키마_v1_0.json
 *   new_doc_l3/2_AXIS L2/3_채점/AXIS_L2_채점_세션집계_JSON스키마_v1_0.json
 *   new_doc_l3/3_AXIS L3/3_AI 채점/AXIS_L3_채점_세션집계_JSON스키마_v1_0.json
 * GENERATED — do not hand-edit; re-copy from the source JSON on standard bumps.
 */

export const L1_SESSION_AGGREGATE_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l1-session-aggregate-v1.1.json",
  "title": "AXIS L1 채점 세션 집계 레코드",
  "description": "v1.1 정정(2026-07-06): review_reasons에 'Part C 검수 기준(12 미만)' 추가 — B·C 템플릿 v2.0 mandatory_expert_review와 동기화(Part C는 하드컷이 아닌 검수 트리거, 기획서 3-1). 응시자 1인의 L1 세션 집계(Part A 25 + Part B 55 + Part C 20 = 100점, 120분). 전 필드 [시스템 산출]. AI 산출분은 파트·문항 단위 레코드에 기록. 합격 잠금은 전문가·관리자 승인 후.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "qualification",
    "level",
    "applicant_ref",
    "exam_session",
    "scores",
    "risk_assessment",
    "review",
    "gate_results",
    "decision_status",
    "audit"
  ],
  "properties": {
    "schema_version": {
      "const": "1.1"
    },
    "qualification": {
      "const": "AXIS"
    },
    "level": {
      "const": "L1"
    },
    "applicant_ref": {
      "type": "string"
    },
    "org_ref": {
      "type": [
        "string",
        "null"
      ]
    },
    "exam_session": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "exam_session_id",
        "exam_form_id",
        "submitted_at",
        "exam_time_limit_minutes",
        "ai_use_blocked",
        "similarity_check_ref"
      ],
      "properties": {
        "exam_session_id": {
          "type": "string"
        },
        "exam_form_id": {
          "type": "string"
        },
        "submitted_at": {
          "type": "string",
          "format": "date-time"
        },
        "exam_time_limit_minutes": {
          "const": 120
        },
        "ai_use_blocked": {
          "const": true,
          "description": "L1 응시 모드 — AI 전면 금지 (기획서 v2.0 3-4)"
        },
        "similarity_check_ref": {
          "type": "string",
          "description": "제출물 유사도 검사 결과 참조"
        }
      }
    },
    "scores": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "part_a_score",
        "part_b_score",
        "part_c_score",
        "total_score"
      ],
      "properties": {
        "part_a_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 25
        },
        "part_b_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 55
        },
        "part_c_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 20
        },
        "total_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        }
      }
    },
    "part_record_refs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "part",
          "record_id"
        ],
        "properties": {
          "part": {
            "enum": [
              "A",
              "B",
              "C1",
              "C2"
            ]
          },
          "record_id": {
            "type": "string"
          }
        }
      }
    },
    "risk_assessment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "risk_flags",
        "critical_fail_detected",
        "critical_fail_patterns"
      ],
      "properties": {
        "risk_flags": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "개인정보",
              "내부기밀",
              "저작권",
              "출처불명",
              "허위정보",
              "수치오류",
              "과장표현",
              "편향",
              "책임소재",
              "보안(외부도구)",
              "최신성한계"
            ]
          }
        },
        "critical_fail_detected": {
          "type": "boolean"
        },
        "critical_fail_patterns": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "법규 위반 전제 계획",
              "시나리오 밖 사실 창작",
              "리스크 통제 섹션 백지·형식 기재"
            ]
          }
        }
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "human_review_required",
        "review_reasons",
        "min_ai_confidence"
      ],
      "properties": {
        "human_review_required": {
          "type": "boolean"
        },
        "review_reasons": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "총점 경계권(65~74)",
              "Part A 경계밴드(11~15)",
              "Part B 경계밴드(30~36)",
              "Part A 최저기준 미달(13 미만)",
              "Part B 최저기준 미달(33 미만)",
              "Part C 검수 기준(12 미만)",
              "계획-리스크 게이트 발동",
              "치명 실패 패턴",
              "위험 플래그",
              "confidence 0.75 미만",
              "제출물 유사도 상위",
              "이의신청"
            ]
          }
        },
        "min_ai_confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    },
    "gate_results": {
      "type": "object",
      "description": "하드컷 3종 (L1 기획서 v2.0 3-1). Part C는 하드컷 없음 — 치명 실패로 통제",
      "additionalProperties": false,
      "required": [
        "total_score_min_70",
        "part_a_min_13",
        "part_b_min_33"
      ],
      "properties": {
        "total_score_min_70": {
          "type": "boolean"
        },
        "part_a_min_13": {
          "type": "boolean"
        },
        "part_b_min_33": {
          "type": "boolean"
        }
      }
    },
    "decision_status": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "final_decision_owner"
      ],
      "properties": {
        "status": {
          "enum": [
            "provisional",
            "in_review",
            "confirmed_pass",
            "confirmed_fail",
            "invalidated"
          ]
        },
        "final_decision_owner": {
          "const": "human_exam_admin_or_review_panel"
        },
        "confirmed_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "confirmed_by_ref": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "audit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "aggregated_at",
        "prompt_version",
        "rubric_version",
        "exam_snapshot_ref"
      ],
      "properties": {
        "aggregated_at": {
          "type": "string",
          "format": "date-time"
        },
        "prompt_version": {
          "type": "string"
        },
        "rubric_version": {
          "type": "string"
        },
        "exam_snapshot_ref": {
          "type": "string"
        }
      }
    }
  }
} as const;

export const L2_SESSION_AGGREGATE_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l2-session-aggregate-v1.0.json",
  "title": "AXIS L2 채점 세션 집계 레코드",
  "description": "응시자 1인의 L2 시험 세션 집계(객관식 30 + 실습 3과제 70 + 이중 게이트). 전 필드 [시스템 산출]. AI 보조채점 산출분은 과제 단위 레코드에 기록되고 본 레코드는 집계다. 합격 잠금은 전문가·관리자 승인 후.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "qualification",
    "level",
    "applicant_ref",
    "exam_session",
    "scores",
    "practice_task_refs",
    "risk_assessment",
    "review",
    "gate_results",
    "decision_status",
    "audit"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "qualification": {
      "const": "AXIS"
    },
    "level": {
      "const": "L2"
    },
    "applicant_ref": {
      "type": "string"
    },
    "org_ref": {
      "type": [
        "string",
        "null"
      ]
    },
    "exam_session": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "exam_session_id",
        "exam_form_id",
        "submitted_at",
        "exam_time_limit_minutes",
        "embedded_ai_version",
        "prompt_log_ref"
      ],
      "properties": {
        "exam_session_id": {
          "type": "string"
        },
        "exam_form_id": {
          "type": "string"
        },
        "submitted_at": {
          "type": "string",
          "format": "date-time"
        },
        "exam_time_limit_minutes": {
          "const": 90
        },
        "embedded_ai_version": {
          "type": "string",
          "description": "L2 응시 모드 — 회차 고정된 내장 AI 모델·버전 (기획서 v2.0 3-3)"
        },
        "prompt_log_ref": {
          "type": "string",
          "description": "응시자 지시문 로그 참조 — 과제 B 채점 근거·이의신청 자료"
        }
      }
    },
    "scores": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "objective_score",
        "practice_score",
        "practice_task_scores",
        "total_score"
      ],
      "properties": {
        "objective_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 30
        },
        "practice_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 70,
          "description": "A+B+C 직접 합산 (direct_70 단일 채점 단위)"
        },
        "practice_task_scores": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "task_A",
            "task_B",
            "task_C"
          ],
          "properties": {
            "task_A": {
              "type": "number",
              "minimum": 0,
              "maximum": 25
            },
            "task_B": {
              "type": "number",
              "minimum": 0,
              "maximum": 25
            },
            "task_C": {
              "type": "number",
              "minimum": 0,
              "maximum": 20
            }
          }
        },
        "total_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        }
      }
    },
    "practice_task_refs": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "task_id",
          "practice_type",
          "task_record_id",
          "task_score",
          "below_40_percent"
        ],
        "properties": {
          "task_id": {
            "type": "string"
          },
          "practice_type": {
            "type": "string"
          },
          "task_record_id": {
            "type": "string"
          },
          "task_score": {
            "type": "number",
            "minimum": 0
          },
          "below_40_percent": {
            "type": "boolean",
            "description": "단일 과제 40% 미만 — 경계검수 트리거"
          }
        }
      }
    },
    "risk_assessment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "risk_flags",
        "critical_fail_detected",
        "critical_fail_patterns"
      ],
      "properties": {
        "risk_flags": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "개인정보",
              "내부기밀",
              "저작권",
              "출처불명",
              "허위정보",
              "수치오류",
              "과장표현",
              "편향",
              "책임소재",
              "보안(외부도구)",
              "최신성한계"
            ]
          }
        },
        "critical_fail_detected": {
          "type": "boolean"
        },
        "critical_fail_patterns": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "개인정보 AI 입력·산출물 잔존",
              "허위·출처불명 수치 무검증 제출",
              "제공 자료 밖 사실 창작"
            ]
          }
        }
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "human_review_required",
        "review_reasons",
        "min_task_ai_confidence"
      ],
      "properties": {
        "human_review_required": {
          "type": "boolean"
        },
        "review_reasons": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "총점 경계권(65~74)",
              "객관식 경계밴드(13~17)",
              "실습형 경계밴드(38~45)",
              "객관식 최저기준 미달(15 미만)",
              "실습형 최저기준 미달(42 미만)",
              "단일 과제 40% 미만",
              "산출물-검증 게이트 발동",
              "치명 실패 패턴",
              "위험 플래그",
              "confidence 0.75 미만 과제 존재",
              "인젝션 의심",
              "이의신청"
            ]
          }
        },
        "min_task_ai_confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    },
    "gate_results": {
      "type": "object",
      "description": "이중 최저기준 하드컷 + 총점 (L2 기획서 v2.0 3-2)",
      "additionalProperties": false,
      "required": [
        "total_score_min_70",
        "objective_score_min_15",
        "practice_score_min_42"
      ],
      "properties": {
        "total_score_min_70": {
          "type": "boolean"
        },
        "objective_score_min_15": {
          "type": "boolean"
        },
        "practice_score_min_42": {
          "type": "boolean"
        }
      }
    },
    "decision_status": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "final_decision_owner"
      ],
      "properties": {
        "status": {
          "enum": [
            "provisional",
            "in_review",
            "confirmed_pass",
            "confirmed_fail",
            "invalidated"
          ]
        },
        "final_decision_owner": {
          "const": "human_exam_admin_or_review_panel"
        },
        "confirmed_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "confirmed_by_ref": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "audit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "aggregated_at",
        "prompt_version",
        "rubric_version",
        "exam_snapshot_ref",
        "prompt_log_hash"
      ],
      "properties": {
        "aggregated_at": {
          "type": "string",
          "format": "date-time"
        },
        "prompt_version": {
          "type": "string"
        },
        "rubric_version": {
          "type": "string"
        },
        "exam_snapshot_ref": {
          "type": "string"
        },
        "prompt_log_hash": {
          "type": "string",
          "description": "지시문 로그 전문 해시 (변조 검증)"
        }
      }
    }
  }
} as const;

export const L3_SESSION_AGGREGATE_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l3-session-aggregate-v1.0.json",
  "title": "AXIS L3 채점 세션 집계 레코드",
  "description": "응시자 1인의 시험 세션 전체(객관식 총점 + 실습 4문항 + 합격 게이트) 집계 레코드. 전 필드 [시스템 산출] — AI는 이 레코드를 생성하지 않으며, 문항 단위 AI 산출분은 AXIS_L3_AI채점_결과_JSON스키마_v1_0.json(문항 레코드)에 기록되고 본 레코드는 그 집계다. 합격 판정 잠금은 전문가 검수·관리자 승인 이후에만 수행한다.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "qualification",
    "level",
    "applicant_ref",
    "exam_session",
    "scores",
    "practice_item_refs",
    "risk_assessment",
    "review",
    "gate_results",
    "decision_status",
    "audit"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "qualification": {
      "const": "AXIS"
    },
    "level": {
      "const": "L3"
    },
    "applicant_ref": {
      "type": "string",
      "description": "응시자 비식별 해시 ID (원식별자 저장 금지)"
    },
    "org_ref": {
      "type": [
        "string",
        "null"
      ],
      "description": "B2B 조직·부서 비식별 참조 (리포트용)"
    },
    "exam_session": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "exam_session_id",
        "exam_form_id",
        "submitted_at",
        "exam_time_limit_minutes"
      ],
      "properties": {
        "exam_session_id": {
          "type": "string"
        },
        "exam_form_id": {
          "type": "string",
          "description": "층화 생성된 시험지 ID — exam_snapshot 로그와 연결"
        },
        "submitted_at": {
          "type": "string",
          "format": "date-time"
        },
        "exam_time_limit_minutes": {
          "const": 70
        },
        "scoring_run_id": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "scores": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "objective_score",
        "practice_score",
        "total_score"
      ],
      "properties": {
        "objective_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 60
        },
        "practice_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 40,
          "description": "4문항 provisional_item_total 합. 전문가 조정 반영 후 갱신"
        },
        "total_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        }
      }
    },
    "practice_item_refs": {
      "type": "array",
      "minItems": 4,
      "maxItems": 4,
      "description": "문항 단위 채점 레코드(문항 스키마 v1.0) 참조",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "item_id",
          "practice_type",
          "item_record_id",
          "item_score"
        ],
        "properties": {
          "item_id": {
            "type": "string"
          },
          "practice_type": {
            "enum": [
              "현업적용형",
              "지시설계형",
              "분석·검증형",
              "리스크 판단형"
            ]
          },
          "item_record_id": {
            "type": "string",
            "description": "문항 레코드의 저장 키"
          },
          "item_score": {
            "type": "number",
            "minimum": 0,
            "maximum": 10
          }
        }
      }
    },
    "risk_assessment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "risk_flags",
        "highest_severity",
        "critical_risk_detected"
      ],
      "properties": {
        "risk_flags": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "개인정보 입력",
              "기밀정보 입력",
              "검증 생략",
              "허위정보 신뢰",
              "출처불명 수치 방치",
              "저작권 위험",
              "보안 위험",
              "과장표현 방치",
              "책임소재 불명확",
              "사람 검토 생략"
            ]
          },
          "description": "4문항 레코드의 risk_flags 합집합 (통제어휘)"
        },
        "highest_severity": {
          "enum": [
            "none",
            "medium",
            "high",
            "critical"
          ],
          "description": "개발자 명세서의 플래그→severity 매핑표로 시스템이 산정"
        },
        "critical_risk_detected": {
          "type": "boolean"
        }
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "human_review_required",
        "review_reasons",
        "min_item_ai_confidence"
      ],
      "properties": {
        "human_review_required": {
          "type": "boolean"
        },
        "review_reasons": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "총점 경계권(65~74)",
              "실습형 경계밴드(22~26)",
              "실습형 최저기준 미달(24 미만)",
              "객관식 최저기준 미달(30 미만)",
              "리스크 판단형 5점 이하",
              "게이트 발동 문항 존재",
              "위험 플래그",
              "critical 위험",
              "confidence 0.75 미만 문항 존재",
              "인젝션 의심",
              "이의신청"
            ]
          }
        },
        "min_item_ai_confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    },
    "gate_results": {
      "type": "object",
      "description": "이중 최저기준 하드컷 + 총점 (메인 기획서 v2.0 4-4)",
      "additionalProperties": false,
      "required": [
        "total_score_min_70",
        "objective_score_min_30",
        "practice_score_min_24"
      ],
      "properties": {
        "total_score_min_70": {
          "type": "boolean"
        },
        "objective_score_min_30": {
          "type": "boolean"
        },
        "practice_score_min_24": {
          "type": "boolean"
        }
      }
    },
    "decision_status": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "final_decision_owner"
      ],
      "properties": {
        "status": {
          "enum": [
            "provisional",
            "in_review",
            "confirmed_pass",
            "confirmed_fail",
            "invalidated"
          ],
          "description": "provisional은 시스템 집계 직후. confirmed_*는 전문가·관리자 잠금 후에만"
        },
        "final_decision_owner": {
          "const": "human_exam_admin_or_review_panel"
        },
        "confirmed_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "confirmed_by_ref": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "audit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "aggregated_at",
        "item_schema_version",
        "prompt_version",
        "rubric_version",
        "exam_snapshot_ref"
      ],
      "properties": {
        "aggregated_at": {
          "type": "string",
          "format": "date-time"
        },
        "item_schema_version": {
          "const": "1.0"
        },
        "prompt_version": {
          "type": "string"
        },
        "rubric_version": {
          "type": "string"
        },
        "exam_snapshot_ref": {
          "type": "string",
          "description": "응시 시점 시험지 스냅샷 참조"
        }
      }
    }
  }
} as const;

export const SESSION_AGGREGATE_SCHEMAS = {
  L1: L1_SESSION_AGGREGATE_SCHEMA,
  L2: L2_SESSION_AGGREGATE_SCHEMA,
  L3: L3_SESSION_AGGREGATE_SCHEMA,
} as const;
