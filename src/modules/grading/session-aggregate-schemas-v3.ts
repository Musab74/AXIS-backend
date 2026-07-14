/**
 * v3.0 session-aggregate JSON Schemas (draft-07), embedded VERBATIM from the
 * new_version_v3 standard documents so the aggregation service can validate
 * without build-time asset copying. Source of truth:
 *   new_version_v3/1_AXIS L1/1_시스템업로드·검토용_패키지/5_시험·채점_설정/AXIS_L1_채점_세션집계_JSON스키마.json (schema_version 1.2, 150분)
 *   new_version_v3/2_AXIS L2/2_AI 채점/3_채점_세션집계_JSON스키마.json (schema_version 1.1, 120분)
 *   new_version_v3/3_AXIS L3/2_AI 채점/3_AXIS_L3_채점_세션집계_JSON스키마.json (schema_version 1.0, 90분, 실습 8문항)
 * GENERATED — do not hand-edit; re-copy from the source JSON on standard bumps.
 */

export const L1_SESSION_AGGREGATE_SCHEMA_V3 = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l1-session-aggregate.json",
  "title": "AXIS L1 채점 세션 집계 레코드",
  "description": "2026-07-08 개정(schema 1.2): 검정시간 150분(40/70/40)·합격 총점 60·하드컷 4종(총점60/A10/B33/C8)·경계밴드(55~64/8~12/30~36/6~10) 반영 — 확정안·시험설정 명세와 동기화. 응시자 1인의 L1 세션 집계(Part A 25 + Part B 55 + Part C 20 = 100점, 150분). 전 필드 [시스템 산출]. AI 산출분은 파트·문항 단위 레코드에 기록. 합격 잠금은 전문가·관리자 승인 후.",
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
      "const": "1.2"
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
          "const": 150
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
              "총점 경계권(55~64)",
              "Part A 경계밴드(8~12)",
              "Part B 경계밴드(30~36)",
              "Part C 경계밴드(6~10)",
              "Part A 최저기준 미달(10 미만)",
              "Part B 최저기준 미달(33 미만)",
              "Part C 최저기준 미달(8 미만)",
              "Part C 추가 검수(12 미만)",
              "계획-리스크 게이트 발동",
              "치명 실패 패턴",
              "위험 플래그",
              "confidence 0.75 미만",
              "제출물 유사도 상위(0.85 플래그)",
              "이의신청",
              "재접속·이탈 이벤트"
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
      "description": "하드컷 4종 — 비보상 모델(2026-07-08 확정): 총점 60 AND A 10 AND B 33 AND C 8",
      "additionalProperties": false,
      "required": [
        "total_score_min_60",
        "part_a_min_10",
        "part_b_min_33",
        "part_c_min_8"
      ],
      "properties": {
        "total_score_min_60": {
          "type": "boolean"
        },
        "part_a_min_10": {
          "type": "boolean"
        },
        "part_b_min_33": {
          "type": "boolean"
        },
        "part_c_min_8": {
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

export const L2_SESSION_AGGREGATE_SCHEMA_V3 = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l2-session-aggregate-v1.1.json",
  "title": "AXIS L2 채점 세션 집계 레코드",
  "description": "응시자 1인의 L2 시험 세션 집계(객관식 30 + 실습 3과제 70 + 삼중 게이트(총점 60·객관식 12·실습 42)). 전 필드 [시스템 산출]. AI 보조채점 산출분은 과제 단위 레코드에 기록되고 본 레코드는 집계다. 합격 잠금은 전문가·관리자 승인 후. [v1.1: 120분 체제·합격선 60/12/42·경계밴드 55~64/10~14 확정 반영]",
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
      "const": "1.1"
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
          "const": 120,
          "description": "확정 검정시간 — 객관식 50분 + 실습 70분(기획서 v2.2 3-1)"
        },
        "embedded_ai_version": {
          "type": "string",
          "description": "L2 응시 모드 — 회차 고정된 내장 AI 모델·버전 (기획서 v2.0 3-3)"
        },
        "prompt_log_ref": {
          "type": "string",
          "description": "응시자 지시문 로그 참조 — 전 과제 공통 채점 보조 근거('AI 지시·맥락 설계' 요소)·이의신청 자료 (AI채점 프롬프트 v1.1 재정의)"
        },
        "timing_log_ref": {
          "type": [
            "string",
            "null"
          ],
          "description": "문항·과제별 타임스탬프 로그 참조 — 파일럿 소프트 리미트 시간 검증 데이터(재확정안 자동확정 규칙)"
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
              "총점 경계권(55~64)",
              "객관식 경계밴드(10~14)",
              "실습형 경계밴드(38~45)",
              "객관식 최저기준 미달(12 미만)",
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
      "description": "삼중 하드컷 — 총점 60·객관식 12(40%)·실습 42(60%), 하나라도 false면 불합격 (기획서 v2.2 3-2)",
      "additionalProperties": false,
      "required": [
        "total_score_min_60",
        "objective_score_min_12",
        "practice_score_min_42"
      ],
      "properties": {
        "total_score_min_60": {
          "type": "boolean"
        },
        "objective_score_min_12": {
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

export const L3_SESSION_AGGREGATE_SCHEMA_V3 = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://ainex.example/schemas/axis-l3-session-aggregate.json",
  "title": "AXIS L3 채점 세션 집계 레코드",
  "description": "응시자 1인의 시험 세션 전체(객관식 총점 + 실습 8문항 + 합격 게이트) 집계 레코드. 전 필드 [시스템 산출] — AI는 이 레코드를 생성하지 않으며, 문항 단위 AI 산출분은 2_AXIS_L3_AI채점_문항레코드_JSON스키마.json(문항 레코드)에 기록되고 본 레코드는 그 집계다. 합격 판정 잠금은 전문가 검수·관리자 승인 이후에만 수행한다.",
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
          "const": 90
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
          "description": "8문항 원점수 합 × 0.5 환산 (0~40). 전문가 조정 반영 후 갱신"
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
      "minItems": 8,
      "maxItems": 8,
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
            "maximum": 10,
            "description": "문항 원점수(10점 루브릭). 세션 practice_score는 8문항 원점수 합 × 0.5 환산(40점 만점)"
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
              "총점 경계밴드(55~64)",
              "객관식 경계밴드(20~28)",
              "실습형 경계밴드(13~19)",
              "실습형 과락(16 미만)",
              "객관식 과락(24 미만)",
              "리스크 판단형 문항 저득점",
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
      "description": "하드컷 — 총점 60 + 파트 과락 40% (재량 판정 없음)",
      "additionalProperties": false,
      "required": [
        "total_score_min_60",
        "objective_score_min_24",
        "practice_score_min_16"
      ],
      "properties": {
        "total_score_min_60": {
          "type": "boolean"
        },
        "objective_score_min_24": {
          "type": "boolean"
        },
        "practice_score_min_16": {
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

