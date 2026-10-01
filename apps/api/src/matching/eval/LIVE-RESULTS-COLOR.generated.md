# 실제 API 라이브 평가(자동 생성, 합성 이미지)

호출 18회(실패 0), 입력 35371 / 출력 1973 토큰, 평균 지연 2275ms (p95 3772ms), 추정 비용 약 $0.0452 [가정: Haiku 4.5 $1/$5 per M].

| 쌍 | 정답 | 모드 | 설명 | 사진 점수(AI → 색규칙 후) | 총점 | 등급 | 추출 속성(카테고리/색/브랜드) | 민감 감지 | AI 근거 |
|---|---|---|---|---|---|---|---|---|---|
| N2 | NEAR | SEND | 검정 케이스(스티커 있음) vs 검정 케이스(스티커 없음) | 0.45 → 0.70 (FLOOR) | 0.815 | AUTO | earphones/검정+노랑/unknown ↔ earphones/검정/unknown | – | 기본 형태는 유사하나 분실품의 황색 표시가 습득품에 없어 동일 여부 판단 |
| T3 | TRUE | SEND | 같은 검정 우산(걸이형) | 0.25 → 0.70 (FLOOR) | 0.815 | AUTO | other/검정색/unknown ↔ other/검은색+회색/unknown | – | 우산의 기본 색상과 형태는 유사하나, 우산살 모양과 손잡이 위치가 명확히 |
| N5 | NEAR | SEND | 검정 우산 걸이형 vs 직선형 | 0.25 → 0.70 (FLOOR) | 0.815 | AUTO | other/검은색+회색/unknown ↔ other/검정+회색/unknown | – | 검은 우산으로 기본 특징은 맞지만 손잡이와 우산 모양이 뚜렷이 다르므로  |
| N7 | NEAR | SEND | 갈색 지갑 스티치 있음/없음, 색 약간 다름 | 0.65 → 0.70 (FLOOR) | 0.815 | AUTO | wallet/갈색/unknown ↔ wallet/갈색/unknown | – | 색상과 기본 형태는 유사하나, 분실 사진의 점선 표시로 인해 실제 지갑의 |
| N8 | NEAR | SEND | 흰 보조배터리 ANKER vs BASEUS | 0.15 → 0.15 (NONE) | 0.568 | IGNORE | other/초록/Anker ↔ other/흰색+초록색/BASEUS | – | 브랜드가 다른 별개의 보조배터리입니다. 색상만 유사하지만 제조사가 명확히 |
| F3 | FAR | SEND | 검정 케이스 vs 학생증(태그 동일) | 0.15 → 0.15 (NONE) | 0.568 | IGNORE | earphones/검은색+노란색/unknown ↔ student_id/검정색+흰색/unknown | FACE+ID_CARD+DOCUMENT_TEXT | 두 물건 모두 검은색 직사각형이지만, 분실물과 습득물의 용도와 형태가 명 |
