"""Real solver smoke validation; run before/after frontend rebuild, no model mutation."""
import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path
BASE = os.environ.get('DASH_VALIDATION_URL', 'http://127.0.0.1:8018')
def request(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=90) as response: return json.load(response)
examples=request('/api/examples')['examples']
cases=[('traffic-light','2019',{}), ('digital-watch','2023',{}), ('bit-counter-1','Local',{'PID':2}), ('bit-counter-2','Local',{'PID':2}), ('elevator-fixed','Local',{'PID':2,'Floor':3})]
report=[]
for name,group,overrides in cases:
  example=next(e for e in examples if e['name']==name and group in e['group'])
  for mode in ['simplified','raw']:
    started=time.monotonic(); row={'model':name,'mode':mode}
    try:
      inspected=request('/api/inspect', {'filePath':example['path']})
      scopes={sig:overrides.get(sig,1) for sig in inspected['scopeSigs']}
      row.update(scopes=scopes,states=len(inspected['model']['states']),transitions=len(inspected['model']['transitions']))
      init=request('/api/init', {'sigScopes':scopes,'constraints':[],'mode':mode})
      assert init['satisfiable'] and init.get('snapshots'), 'No initial solution'
      state=init['snapshots'][0]; row['initial']=state; row['steps']=[]
      for i in range(3):
        result=request('/api/step', {'state':state,'sigScopes':scopes,'constraints':[],'mode':mode})
        assert result['satisfiable'] and len(result.get('snapshots',[]))>=2, 'No successor'
        state=result['snapshots'][-1]
        assert any('conf' in key.lower() and value for key,value in state.items()), 'Missing active configuration'
        if mode=='simplified': assert any('taken' in key.lower() and value for key,value in state.items()), 'Simplified step without transition'
        row['steps'].append(state)
      # A contradiction must never acquire a satisfying solution through UI settings.
      unsat=request('/api/init', {'sigScopes':scopes,'constraints':['some none'],'mode':mode})
      assert not unsat['satisfiable'], 'Contradictory constraint accepted'
      row['contradictionRejected']=True;row['result']='PASS'
    except Exception as exc: row.update(result='FAIL',error=str(exc))
    row['seconds']=round(time.monotonic()-started,2);report.append(row)
    print(name,mode,row['result'],row.get('error',''),row['seconds'],flush=True)
output_path = Path(sys.argv[1] if len(sys.argv)>1 else 'reports/model-validation.json')
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(report,indent=2),encoding='utf-8')

if len(sys.argv) > 2:
    baseline = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    assert len(baseline) == len(report)
    for before, after in zip(baseline, report):
        for key in ['model', 'mode', 'scopes', 'states', 'transitions', 'result', 'contradictionRejected', 'initial', 'steps']:
            assert before[key] == after[key], f"Baseline mismatch: {after['model']} {after['mode']} {key}"
    print('All recorded initial snapshots and traces exactly match the baseline.', flush=True)

sys.exit(any(row['result']=='FAIL' for row in report))
