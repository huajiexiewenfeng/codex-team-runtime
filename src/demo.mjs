import { createState, evolve } from './runtime.mjs';
export function demoState() {
 const at=n=>new Date(Date.UTC(2026,8,5,0,n)).toISOString();
 const source={kind:'fixture',ref:'offline-demo-v1'};
 const member=(id,role)=>({id,role,name:role==='Worker'?`Worker ${id}`:role,lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-${id}`}});
 let s=createState({teamId:'demo-team',name:'Team Runtime · 最小纵向切片',source,members:[member('manager','Manager'),member('liaison','Liaison'),...Array.from({length:4},(_,i)=>member(`worker-0${i+1}`,'Worker'))]},at(0));
 let minute=0;
 const apply=(type,data={},actor='manager')=>{s=evolve(s,{id:`demo-event-${s.version+1}`,type,actor,at:at(++minute),source,...data},s.version);};
 apply('openRound',{roundId:'round-demo',title:'离线演示轮次'});
 for(let i=1;i<=4;i++) apply('assign',{roundId:'round-demo',taskId:`T-${i}`,title:['状态持久化','审查与返工闭环','宿主导航验证','历史观察导入'][i-1],workerId:`worker-0${i}`,required:true,assignedAt:i===4?null:at(minute+1)});
 const task=(type,i,data={},actor='manager')=>apply(type,{roundId:'round-demo',taskId:`T-${i}`,...data},actor);
 task('observe',1,{observedAt:at(minute),summary:'示例：原子写入测试通过',progress:true},'worker-01');
 task('submit',1,{summary:'示例交付，待 Manager 检查'},'worker-01'); task('review',1); task('approve',1,{summary:'示例独立复核通过（非真实项目交付）',evidence:['fixture:test-result']});
 task('submit',2,{summary:'示例首次提交'},'worker-02'); task('review',2); task('rework',2,{summary:'示例要求补齐时间未知处理'});
 task('submit',2,{summary:'示例第二次提交，等待复验'},'worker-02'); task('review',2);
 task('block',3,{summary:'尚未验证独立 HTML 的宿主导航接口'});
 task('observe',4,{observedAt:null,summary:'示例历史记录缺少观察时间',progress:false},'worker-04');
 return s;
}
