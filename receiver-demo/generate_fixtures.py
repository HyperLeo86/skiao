#!/usr/bin/env python3
"""Generate deterministic synthetic SkyAO V0.2 fixtures. Python 3 stdlib only."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

RUN = 'RUN-TEST-001'
SAMPLES = {'S01': 'Sample 1', 'S02': 'Sample 2', 'S03': 'Sample 3',
           'S04': 'Sample 4', 'S05': 'Sample 5', 'S06': 'Sample 6'}
GROUPS = {'A': 'Group A', 'B': 'Group B', 'C': 'Group C'}
COMPARISONS = {'C_AB': 'A vs B', 'C_BC': 'B vs C'}
ASSIGN = dict(zip(SAMPLES, ['A', 'A', 'B', 'B', 'C', 'C']))


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def csv_bytes(columns, rows):
    import io
    buf = io.StringIO(newline='')
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(columns)
    writer.writerows(rows)
    return buf.getvalue().encode('utf-8')


def rg(types, sources, editable=True):
    return {'render_types': types, 'sources': sources, 'editable': editable}


def unit(selectors, *groups):
    return {'selectors': selectors, 'render_groups': list(groups)}


def manifest(delivery, section, node, title, order, units):
    return {'schema_version': '0.2', 'delivery_id': delivery,
            'analysis_run_id': RUN, 'section_key': section, 'node_key': node,
            'node_title': title, 'sort_order': order, 'result_units': units}


def write_case(root, folder, m, files):
    folder = root / folder
    (folder / 'files').mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (folder / 'files' / name).write_bytes(content)
    m = {**m, 'artifacts': [dict(file_name=name, size_bytes=len(content),
                              sha256=hashlib.sha256(content).hexdigest())
                           for name, content in files.items()]}
    dump(folder / 'manifest.json', m)
    return m


def expression(sample, offset=0):
    i = int(sample[1:])
    return csv_bytes(['feature_id', 'log2_expression'],
                     [(f'G{j:03}', round(4 + (j % 13)*0.32 + i*0.18
                       + math.sin(j+i)*0.37 + offset, 4)) for j in range(1, 61)])


def differential(shift):
    rows = []
    for j in range(1, 61):
        fc = round(math.sin(j*0.8 + shift)*2.9, 4)
        p = round(10**(-0.15-abs(fc)*1.1), 8)
        rows.append((f'G{j:03}', round(4+(j % 11)*0.4, 3), fc, p))
    return csv_bytes(['feature_id','mean_log2_expression','log2_fc','p_adjusted'], rows)


def main(root):
    root.mkdir(parents=True, exist_ok=True)
    dump(root/'seed.json', {'analysis_run_id': RUN, 'samples': SAMPLES,
         'groups': GROUPS, 'sample_groups': ASSIGN, 'comparisons': COMPARISONS,
         'comparison_definitions': {'C_AB': {'numerator':'A','denominator':'B'},
                                    'C_BC': {'numerator':'B','denominator':'C'}},
         'feature_levels': {'gene':'基因','isoform':'转录本'},
         'sections': {'qc': {'title':'质量控制','order':10},
                      'expression': {'title':'表达量分析','order':20},
                      'differential': {'title':'差异分析','order':30}}})
    # 01: single node, two sample units, three render types + table each.
    expr_units = [unit({'sample': s}, rg(['boxplot','violin','density','table'],
                  {'data': f'{s}.csv'})) for s in ['S01','S02']]
    expr_files = {f'{s}.csv':expression(s) for s in ['S01','S02']}
    expr_m = manifest('DEL-TEST-001','expression','expression_distribution','样本表达量分布',10,expr_units)
    write_case(root,'01_samples',expr_m,expr_files)
    # 02: comparison selection; same node contains distinct rendering groups.
    diff_units = [unit({'comparison': c}, rg(['volcano','ma_plot','table'],
                  {'data':f'{c}.csv'})) for c in COMPARISONS]
    write_case(root,'02_comparisons',manifest('DEL-TEST-002','differential',
               'gene_expression','基因差异表达分析',10,diff_units),
               {f'{c}.csv':differential(i) for i,c in enumerate(COMPARISONS)})
    # 03: whole-run result, one view uses two files; one file used again for table.
    matrix = csv_bytes(['feature_id',*SAMPLES], [(f'G{j:03}', *[
              round(4 + j*.2 + i*.3 + math.sin(j*i+1), 3)
              for i in range(1,7)]) for j in range(1,13)])
    annotation = csv_bytes(['sample_id','group'], ASSIGN.items())
    pca = csv_bytes(['sample_id','group','PC1','PC2'], [
          (s,ASSIGN[s],x,y) for s,x,y in zip(SAMPLES,[-3,-2.8,0,.2,2.8,3.1],[-.2,.3,1,.8,-1,-.8])])
    write_case(root,'03_overview',manifest('DEL-TEST-003','expression',
              'overall_expression','整体表达概览',20,[unit({},
              rg(['heatmap'],{'matrix':'matrix.csv','annotation':'annotation.csv'}),
              rg(['table'],{'data':'matrix.csv'},False),
              rg(['pca'],{'data':'pca.csv'}))]),
              {'matrix.csv':matrix,'annotation.csv':annotation,'pca.csv':pca})
    # 04: update S02 only. S01 must remain visible and unchanged.
    update_m = manifest('DEL-TEST-004','expression','expression_distribution',
               '样本表达量分布',10,[expr_units[1]])
    write_case(root,'04_update_s02',update_m,{'S02.csv':expression('S02',1.25)})
    # 05: two selector dimensions, sparse combinations (no C_BC isoform).
    sparse = [('C_AB','gene'),('C_AB','isoform'),('C_BC','gene')]
    write_case(root,'05_multi_dimensions',manifest('DEL-TEST-005','differential',
              'multi_level_diff','多层级差异分析',20,[unit({'comparison':c,'feature_level':l},
              rg(['volcano'],{'data':f'{c}_{l}.csv'})) for c,l in sparse]),
              {f'{c}_{l}.csv':differential(i+2) for i,(c,l) in enumerate(sparse)})
    # 90: valid but changed bytes with reused delivery id. Must be rejected 409.
    write_case(root,'90_id_conflict',expr_m,{**expr_files,'S02.csv':expression('S02',2)})
    # 91: manifest describes good bytes, actual file corrupted. Bypass normal CLI to test server.
    write_case(root,'91_bad_checksum',{**expr_m,'delivery_id':'DEL-TEST-091'},expr_files)
    p = root/'91_bad_checksum'/'files'/'S02.csv'
    b = p.read_bytes(); p.write_bytes(bytes([b[0]^1])+b[1:])  # unchanged length
    # 92: missing source reference, manifest files otherwise valid.
    write_case(root,'92_bad_source',manifest('DEL-TEST-092','expression','bad_source',
              '错误引用',90,[unit({},rg(['table'],{'data':'missing.csv'}))]),{'S01.csv':expression('S01')})
    # 93: unknown sample identity.
    write_case(root,'93_bad_selector',manifest('DEL-TEST-093','expression','bad_selector',
              '错误样本',91,[unit({'sample':'S99'},rg(['table'],{'data':'S01.csv'}))]),{'S01.csv':expression('S01')})
    # 94: unknown renderer. No arbitrary code execution.
    write_case(root,'94_bad_renderer',manifest('DEL-TEST-094','expression','bad_renderer',
              '错误渲染器',92,[unit({},rg(['unknown_renderer'],{'data':'S01.csv'}))]),{'S01.csv':expression('S01')})
    (root/'README.txt').write_text('Synthetic data only. Run 01,02,03,04,05 in order; replay 01 before and after 04. Negative fixtures 90-94. See the MD task specification.\n',encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='fixtures', type=Path)
    main(parser.parse_args().out)
