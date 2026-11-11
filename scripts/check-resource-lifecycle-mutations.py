#!/usr/bin/env python3
"""Exercise the real guards in an isolated worktree and restore their exact bytes."""
from pathlib import Path
import argparse, hashlib, json, subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=False)
repo=Path(__file__).resolve().parents[1]
gitdir=Path(subprocess.check_output(['git','rev-parse','--absolute-git-dir'],cwd=repo,text=True).strip()).resolve()
common=Path(subprocess.check_output(['git','rev-parse','--path-format=absolute','--git-common-dir'],cwd=repo,text=True).strip()).resolve()
assert gitdir!=common and (repo/'.git').is_file(), 'Mutation replay requires an isolated linked Git worktree'
cases=[
 ('editable-overwrite','packages/core/src/shared-file-state.ts','if (input.existing_editable_page)',
  'if (false && input.existing_editable_page)','packages/core/test/shared-file-state.test.ts','timestamp check'),
 ('custom-takeover','packages/core/src/shared-file-state.ts',
  '''if (
      event.kind === "projected" &&
      parentStates.some((parent) => parent.kind !== "following" || isResourceFollowing(parent))
    )''',
  '''if (
      false && event.kind === "projected" &&
      parentStates.some((parent) => parent.kind !== "following" || isResourceFollowing(parent))
    )''',
  'packages/core/test/shared-file-state.test.ts','metadata-only observation'),
 ('audit-readonly','packages/core/src/shared-file-observer.ts','if (input.readOnly)',
  'if (false && input.readOnly)','packages/core/test/shared-file-observer-readonly.test.ts','audit-style observation'),
 ('readonly-capability','packages/core/src/notion-readonly.ts',
  '''if (
          !relativeNotionPath(path) ||
          (method === "GET" && body !== undefined) ||
          !isCoalescibleNotionRead({ key: "readonly", path, method, file: options?.file })
        )''',
  'if (false)','packages/core/test/notion-readonly-observation.test.ts','auto-adopting consumer'),
]
results=[]
def execute(label,test,pattern):
 p=subprocess.run(['bun','test',test,'-t',pattern],cwd=repo,capture_output=True,text=True,timeout=40)
 (args.out/(label+'.log')).write_text(p.stdout+p.stderr)
 return p
for name,file,old,new,test,pattern in cases:
 path=repo/file;original=path.read_bytes();text=original.decode();assert text.count(old)==1,(file,old)
 before=execute(name+'-baseline',test,pattern);assert before.returncode==0,before.stderr
 mutated=text.replace(old,new).encode();path.write_bytes(mutated)
 try:
  broken=execute(name+'-mutant',test,pattern)
  assert broken.returncode!=0,'The real-code mutation was not detected'
  assert '(fail)' in broken.stderr+broken.stdout,'Do not count syntax/tool errors as mutation detection'
 finally:
  assert path.read_bytes()==mutated,'Concurrent source change: preserve and inspect it'
  path.write_bytes(original)
 after=execute(name+'-restored',test,pattern);assert after.returncode==0,after.stderr
 assert path.read_bytes()==original
 results.append({'case':name,'file':file,'before_exit':before.returncode,'broken_exit':broken.returncode,'restored_exit':after.returncode,'sha256':hashlib.sha256(original).hexdigest()})
 (args.out/'summary.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'passed':True,'real_guard_mutations_caught':len(results),'results':results}))
